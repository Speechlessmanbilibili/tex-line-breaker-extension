use serde::{Deserialize, Serialize};
use std::slice;

const STATE_COUNT: usize = 8;

#[derive(Debug, Deserialize)]
struct Input {
    units: Vec<Unit>,
    line_width: f64,
    #[serde(default = "default_pretolerance")]
    pretolerance: f64,
    #[serde(default = "default_tolerance")]
    tolerance: f64,
    #[serde(default)]
    emergency_stretch: f64,
    #[serde(default = "default_line_penalty")]
    line_penalty: f64,
    #[serde(default = "default_fitness_demerits")]
    fitness_demerits: f64,
    #[serde(default = "default_double_hyphen_demerits")]
    double_hyphen_demerits: f64,
    #[serde(default = "default_final_hyphen_demerits")]
    final_hyphen_demerits: f64,
    #[serde(default = "default_short_last_line_penalty")]
    short_last_line_penalty: f64,
    #[serde(default = "default_orphan_penalty")]
    orphan_penalty: f64,
}

#[derive(Debug, Deserialize)]
struct Unit {
    width: f64,
    #[serde(default)]
    can_break_after: bool,
    #[serde(default)]
    forced_break_after: bool,
    #[serde(default)]
    penalty: f64,
    #[serde(default)]
    flagged: bool,
    #[serde(default)]
    discretionary: bool,
    #[serde(default)]
    stretch: f64,
    #[serde(default)]
    shrink: f64,
    #[serde(default)]
    discard_at_break: bool,
    #[serde(default)]
    discard_width_at_break: f64,
    #[serde(default)]
    insert_width_at_break: f64,
    #[serde(default)]
    start_protrusion: f64,
    #[serde(default)]
    end_protrusion: f64,
    #[serde(default = "default_visible_units")]
    visible_units: usize,
}

#[derive(Clone, Copy, Debug)]
struct Metrics {
    ratio: f64,
    badness: f64,
    penalty: f64,
    adjustment: f64,
    emergency: f64,
    start_protrusion: f64,
    end_protrusion: f64,
    insert_width: f64,
    flagged: bool,
    forced: bool,
    visible_units: usize,
    natural_width: f64,
}

#[derive(Clone, Copy, Debug)]
struct Previous {
    start: usize,
    state: usize,
    metrics: Metrics,
}

#[derive(Debug, Serialize)]
struct Output {
    lines: Vec<Line>,
    demerits: f64,
    fallback: bool,
    pass: &'static str,
}

#[derive(Debug, Serialize)]
struct Line {
    start: usize,
    end: usize,
    ratio: f64,
    adjustment: f64,
    emergency_stretch: f64,
    badness: f64,
    penalty: f64,
    start_protrusion: f64,
    end_protrusion: f64,
    insert_width: f64,
    flagged: bool,
    forced: bool,
}

fn default_pretolerance() -> f64 {
    1.0
}
fn default_tolerance() -> f64 {
    3.0
}
fn default_line_penalty() -> f64 {
    10.0
}
fn default_fitness_demerits() -> f64 {
    3_000.0
}
fn default_double_hyphen_demerits() -> f64 {
    10_000.0
}
fn default_final_hyphen_demerits() -> f64 {
    5_000.0
}
fn default_short_last_line_penalty() -> f64 {
    2_500.0
}
fn default_orphan_penalty() -> f64 {
    5_000.0
}
fn default_visible_units() -> usize {
    1
}
fn badness(ratio: f64) -> f64 {
    (100.0 * ratio.abs().powi(3)).min(10_000.0)
}

fn fitness(ratio: f64) -> usize {
    if ratio < -0.5 {
        0
    } else if ratio <= 0.5 {
        1
    } else if ratio <= 1.0 {
        2
    } else {
        3
    }
}

fn state_index(class: usize, flagged: bool) -> usize {
    class * 2 + usize::from(flagged)
}
fn state_class(state: usize) -> usize {
    state / 2
}
fn state_flagged(state: usize) -> bool {
    state % 2 == 1
}

fn line_metrics(
    input: &Input,
    start: usize,
    end: usize,
    last: bool,
    allow_discretionary: bool,
    tolerance: f64,
    emergency_stretch: f64,
) -> Option<Metrics> {
    if start >= end
        || input.units[start..end.saturating_sub(1)]
            .iter()
            .any(|unit| unit.forced_break_after)
    {
        return None;
    }
    let break_unit = &input.units[end - 1];
    if break_unit.discretionary && !allow_discretionary && !last {
        return None;
    }

    let mut width = 0.0;
    let mut stretch = 0.0;
    let mut shrink = 0.0;
    let mut visible_units = 0;
    for unit in &input.units[start..end] {
        width += unit.width;
        stretch += unit.stretch;
        shrink += unit.shrink;
        visible_units += unit.visible_units;
    }
    if break_unit.discard_at_break {
        width -= break_unit.width;
        stretch -= break_unit.stretch;
        shrink -= break_unit.shrink;
        visible_units = visible_units.saturating_sub(break_unit.visible_units);
    } else {
        width -= break_unit.discard_width_at_break;
        stretch -= break_unit.stretch;
        shrink -= break_unit.shrink;
    }

    let insert_width = if last {
        0.0
    } else {
        break_unit.insert_width_at_break
    };
    width += insert_width;
    let first_visible = input.units[start..end]
        .iter()
        .find(|unit| unit.visible_units > 0);
    let last_visible = input.units[start..end]
        .iter()
        .rev()
        .find(|unit| unit.visible_units > 0);
    let start_protrusion = first_visible.map_or(0.0, |unit| unit.start_protrusion);
    let end_protrusion = last_visible.map_or(0.0, |unit| unit.end_protrusion);
    let natural_width = (width - start_protrusion - end_protrusion).max(0.0);
    let adjustment = input.line_width - natural_width;

    if last && adjustment >= 0.0 && !break_unit.forced_break_after {
        return Some(Metrics {
            ratio: 0.0,
            badness: 0.0,
            penalty: break_unit.penalty,
            adjustment: 0.0,
            emergency: 0.0,
            start_protrusion,
            end_protrusion,
            insert_width,
            flagged: false,
            forced: false,
            visible_units,
            natural_width,
        });
    }
    let available = if adjustment >= 0.0 {
        stretch.max(0.0) + emergency_stretch.max(0.0)
    } else {
        shrink.max(0.0)
    };
    if available <= 0.0 {
        return None;
    }
    let ratio = adjustment / available;
    if ratio > tolerance || ratio < -1.0 {
        return None;
    }
    Some(Metrics {
        ratio,
        badness: badness(ratio),
        penalty: break_unit.penalty,
        adjustment,
        emergency: if adjustment >= 0.0 {
            emergency_stretch.max(0.0)
        } else {
            0.0
        },
        start_protrusion,
        end_protrusion,
        insert_width,
        flagged: break_unit.flagged && !last,
        forced: break_unit.forced_break_after,
        visible_units,
        natural_width,
    })
}

fn solve_pass(
    input: &Input,
    allow_discretionary: bool,
    tolerance: f64,
    emergency_stretch: f64,
    pass: &'static str,
) -> Option<Output> {
    let n = input.units.len();
    let mut best = vec![[f64::INFINITY; STATE_COUNT]; n + 1];
    let mut previous = vec![[None::<Previous>; STATE_COUNT]; n + 1];
    best[0][state_index(1, false)] = 0.0;
    for end in 1..=n {
        let last = end == n;
        let break_unit = &input.units[end - 1];
        if !last && !break_unit.can_break_after && !break_unit.forced_break_after {
            continue;
        }
        for start in 0..end {
            let Some(metrics) = line_metrics(
                input,
                start,
                end,
                last,
                allow_discretionary,
                tolerance,
                emergency_stretch,
            ) else {
                continue;
            };
            let class = fitness(metrics.ratio);
            let current_state = state_index(class, metrics.flagged);
            for prior_state in 0..STATE_COUNT {
                if !best[start][prior_state].is_finite() {
                    continue;
                }
                let mut line_demerits = (input.line_penalty + metrics.badness).powi(2);
                if !metrics.forced {
                    if metrics.penalty >= 0.0 {
                        line_demerits += metrics.penalty.powi(2);
                    } else {
                        line_demerits -= metrics.penalty.powi(2);
                    }
                }
                if class.abs_diff(state_class(prior_state)) > 1 {
                    line_demerits += input.fitness_demerits;
                }
                if metrics.flagged && state_flagged(prior_state) {
                    line_demerits += input.double_hyphen_demerits;
                }
                if last && state_flagged(prior_state) {
                    line_demerits += input.final_hyphen_demerits;
                }
                if last && start > 0 && metrics.natural_width < input.line_width * 0.35 {
                    line_demerits += input.short_last_line_penalty;
                }
                if last && start > 0 && metrics.visible_units <= 1 {
                    line_demerits += input.orphan_penalty;
                }
                let total = best[start][prior_state] + line_demerits.max(0.0);
                if total < best[end][current_state] {
                    best[end][current_state] = total;
                    previous[end][current_state] = Some(Previous {
                        start,
                        state: prior_state,
                        metrics,
                    });
                }
            }
        }
    }
    let (mut state, &demerits) = best[n]
        .iter()
        .enumerate()
        .min_by(|a, b| a.1.total_cmp(b.1))?;
    if !demerits.is_finite() {
        return None;
    }
    let mut lines = Vec::new();
    let mut end = n;
    while end > 0 {
        let item = previous[end][state]?;
        lines.push(Line {
            start: item.start,
            end,
            ratio: item.metrics.ratio,
            adjustment: item.metrics.adjustment,
            emergency_stretch: item.metrics.emergency,
            badness: item.metrics.badness,
            penalty: item.metrics.penalty,
            start_protrusion: item.metrics.start_protrusion,
            end_protrusion: item.metrics.end_protrusion,
            insert_width: item.metrics.insert_width,
            flagged: item.metrics.flagged,
            forced: item.metrics.forced,
        });
        end = item.start;
        state = item.state;
    }
    lines.reverse();
    Some(Output {
        lines,
        demerits,
        fallback: false,
        pass,
    })
}

fn solve(input: &Input) -> Output {
    if let Some(output) = solve_pass(input, false, input.pretolerance, 0.0, "pretolerance") {
        return output;
    }
    if let Some(output) = solve_pass(input, true, input.tolerance, 0.0, "tolerance") {
        return output;
    }
    if input.emergency_stretch > 0.0 {
        if let Some(output) = solve_pass(
            input,
            true,
            input.tolerance,
            input.emergency_stretch,
            "emergency",
        ) {
            return output;
        }
    }
    greedy(input)
}

fn greedy(input: &Input) -> Output {
    let n = input.units.len();
    let mut lines = Vec::new();
    let mut start = 0;
    while start < n {
        let mut width = 0.0;
        let mut last_break = None;
        let mut end = start;
        while end < n {
            let unit = &input.units[end];
            width += unit.width;
            let effective = if unit.discard_at_break {
                width - unit.width
            } else {
                width - unit.discard_width_at_break
            };
            if unit.forced_break_after {
                last_break = Some(end + 1);
                break;
            }
            if effective > input.line_width && end > start {
                break;
            }
            if unit.can_break_after || end + 1 == n {
                last_break = Some(end + 1);
            }
            end += 1;
        }
        let chosen = last_break
            .filter(|value| *value > start)
            .unwrap_or((start + 1).min(n));
        let break_unit = &input.units[chosen - 1];
        lines.push(Line {
            start,
            end: chosen,
            ratio: 0.0,
            adjustment: 0.0,
            emergency_stretch: 0.0,
            badness: if width > input.line_width {
                10_000.0
            } else {
                0.0
            },
            penalty: break_unit.penalty,
            start_protrusion: input.units[start].start_protrusion,
            end_protrusion: break_unit.end_protrusion,
            insert_width: if chosen < n {
                break_unit.insert_width_at_break
            } else {
                0.0
            },
            flagged: break_unit.flagged && chosen < n,
            forced: break_unit.forced_break_after,
        });
        start = chosen;
    }
    Output {
        lines,
        demerits: 10_000.0,
        fallback: true,
        pass: "fallback",
    }
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = Vec::<u8>::with_capacity(len);
    let ptr = buffer.as_mut_ptr();
    std::mem::forget(buffer);
    ptr
}

/// Releases a buffer previously returned by [`alloc`].
///
/// # Safety
///
/// `ptr` must have been returned by `alloc(len)` and must not have been freed already.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        drop(Vec::from_raw_parts(ptr, 0, len));
    }
}

/// Runs the line-breaking solver for a UTF-8 JSON input buffer.
///
/// # Safety
///
/// `ptr` must reference at least `len` readable bytes for the duration of the call.
#[no_mangle]
pub unsafe extern "C" fn layout(ptr: *const u8, len: usize) -> u64 {
    let Ok(input) = serde_json::from_slice::<Input>(slice::from_raw_parts(ptr, len)) else {
        return 0;
    };
    if input.units.is_empty() || input.line_width <= 0.0 {
        return 0;
    }
    encode(solve(&input))
}

fn encode(output: Output) -> u64 {
    let bytes = serde_json::to_vec(&output).unwrap_or_default();
    let len = bytes.len();
    let ptr = alloc(len);
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, len);
    }
    ((ptr as u64) << 32) | len as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(width: f64, can_break_after: bool) -> Unit {
        Unit {
            width,
            can_break_after,
            forced_break_after: false,
            penalty: 0.0,
            flagged: false,
            discretionary: false,
            stretch: 8.0,
            shrink: 4.0,
            discard_at_break: false,
            discard_width_at_break: 0.0,
            insert_width_at_break: 0.0,
            start_protrusion: 0.0,
            end_protrusion: 0.0,
            visible_units: 1,
        }
    }

    fn input(units: Vec<Unit>, line_width: f64) -> Input {
        Input {
            units,
            line_width,
            pretolerance: 1.0,
            tolerance: 3.0,
            emergency_stretch: 0.0,
            line_penalty: 10.0,
            fitness_demerits: 3_000.0,
            double_hyphen_demerits: 10_000.0,
            final_hyphen_demerits: 5_000.0,
            short_last_line_penalty: 2_500.0,
            orphan_penalty: 5_000.0,
        }
    }

    #[test]
    fn creates_multiple_lines() {
        let output = solve(&input(
            vec![unit(40.0, true), unit(40.0, true), unit(40.0, true)],
            85.0,
        ));
        assert_eq!(output.lines.len(), 2);
        assert_eq!((output.lines[0].start, output.lines[0].end), (0, 2));
    }

    #[test]
    fn leaves_last_line_ragged() {
        let output = solve(&input(vec![unit(45.0, true), unit(20.0, true)], 100.0));
        assert_eq!(output.lines.len(), 1);
        assert_eq!(output.lines[0].ratio, 0.0);
    }

    #[test]
    fn forced_break_cannot_be_crossed() {
        let mut forced = unit(20.0, true);
        forced.forced_break_after = true;
        forced.discard_at_break = true;
        forced.visible_units = 0;
        let output = solve(&input(
            vec![unit(20.0, true), forced, unit(20.0, true)],
            100.0,
        ));
        assert_eq!(output.lines.len(), 2);
        assert!(output.lines[0].forced);
    }

    #[test]
    fn hanging_punctuation_increases_effective_capacity() {
        let mut punctuation = unit(20.0, true);
        punctuation.end_protrusion = 10.0;
        let output = solve(&input(vec![unit(80.0, false), punctuation], 90.0));
        assert!(!output.fallback);
    }

    #[test]
    fn uses_emergency_pass_when_normal_stretch_is_insufficient() {
        let mut data = input(vec![unit(70.0, true), unit(70.0, true)], 100.0);
        data.pretolerance = 0.1;
        data.tolerance = 0.5;
        data.emergency_stretch = 60.0;
        let output = solve(&data);
        assert_eq!(output.pass, "emergency");
    }
}
