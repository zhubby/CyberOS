use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::Duration;

pub const STICK_ACTIVATE: f64 = 0.55;
pub const STICK_RELEASE: f64 = 0.35;
pub const REPEAT_DELAY: Duration = Duration::from_millis(350);
pub const REPEAT_INTERVAL: Duration = Duration::from_millis(120);

pub mod code {
    pub const ABS_X: u16 = 0x00;
    pub const ABS_Y: u16 = 0x01;
    pub const ABS_HAT0X: u16 = 0x10;
    pub const ABS_HAT0Y: u16 = 0x11;

    pub const BTN_SOUTH: u16 = 0x130;
    pub const BTN_EAST: u16 = 0x131;
    pub const BTN_NORTH: u16 = 0x133;
    pub const BTN_WEST: u16 = 0x134;
    pub const BTN_TL: u16 = 0x136;
    pub const BTN_TR: u16 = 0x137;
    pub const BTN_START: u16 = 0x13b;
    pub const BTN_DPAD_UP: u16 = 0x220;
    pub const BTN_DPAD_DOWN: u16 = 0x221;
    pub const BTN_DPAD_LEFT: u16 = 0x222;
    pub const BTN_DPAD_RIGHT: u16 = 0x223;
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum Direction {
    Up,
    Down,
    Left,
    Right,
}

impl Direction {
    pub fn key(self) -> &'static str {
        match self {
            Self::Up => "Up",
            Self::Down => "Down",
            Self::Left => "Left",
            Self::Right => "Right",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputEvent {
    Button { code: u16, value: i32 },
    Axis { code: u16, value: i32 },
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisRange {
    pub minimum: i32,
    pub maximum: i32,
}

impl AxisRange {
    pub fn normalize(self, value: i32) -> f64 {
        if self.maximum <= self.minimum {
            return 0.0;
        }
        let position = (f64::from(value) - f64::from(self.minimum))
            / (f64::from(self.maximum) - f64::from(self.minimum));
        (position * 2.0 - 1.0).clamp(-1.0, 1.0)
    }
}

#[derive(Debug, Default)]
pub struct CapabilityDescriptor {
    pub keys: HashSet<u16>,
    pub axes: HashSet<u16>,
}

impl CapabilityDescriptor {
    pub fn is_supported_gamepad(&self) -> bool {
        let has_face_buttons =
            self.keys.contains(&code::BTN_SOUTH) && self.keys.contains(&code::BTN_EAST);
        let has_stick = self.axes.contains(&code::ABS_X) && self.axes.contains(&code::ABS_Y);
        let has_hat = self.axes.contains(&code::ABS_HAT0X) && self.axes.contains(&code::ABS_HAT0Y);
        let has_dpad_buttons = [
            code::BTN_DPAD_UP,
            code::BTN_DPAD_DOWN,
            code::BTN_DPAD_LEFT,
            code::BTN_DPAD_RIGHT,
        ]
        .into_iter()
        .all(|key| self.keys.contains(&key));
        has_face_buttons && (has_stick || has_hat || has_dpad_buttons)
    }
}

#[derive(Debug)]
struct DeviceState {
    ranges: HashMap<u16, AxisRange>,
    pressed_buttons: HashSet<u16>,
    dpad_buttons: BTreeSet<Direction>,
    active_directions: BTreeSet<Direction>,
    stick_direction: Option<Direction>,
    stick_x: f64,
    stick_y: f64,
    hat_x: i32,
    hat_y: i32,
    repeat_deadlines: HashMap<Direction, Duration>,
}

impl DeviceState {
    fn new(ranges: HashMap<u16, AxisRange>) -> Self {
        Self {
            ranges,
            pressed_buttons: HashSet::new(),
            dpad_buttons: BTreeSet::new(),
            active_directions: BTreeSet::new(),
            stick_direction: None,
            stick_x: 0.0,
            stick_y: 0.0,
            hat_x: 0,
            hat_y: 0,
            repeat_deadlines: HashMap::new(),
        }
    }

    fn handle(&mut self, event: InputEvent, now: Duration) -> Vec<&'static str> {
        match event {
            InputEvent::Button { code, value } => self.handle_button(code, value, now),
            InputEvent::Axis { code, value } => self.handle_axis(code, value, now),
        }
    }

    fn handle_button(&mut self, button: u16, value: i32, now: Duration) -> Vec<&'static str> {
        if let Some(direction) = dpad_direction(button) {
            if value == 0 {
                self.dpad_buttons.remove(&direction);
            } else if value == 1 {
                self.dpad_buttons.insert(direction);
            }
            return self.reconcile_directions(now);
        }

        if value == 0 {
            self.pressed_buttons.remove(&button);
            return Vec::new();
        }
        if value != 1 || !self.pressed_buttons.insert(button) {
            return Vec::new();
        }
        button_key(button).into_iter().collect()
    }

    fn handle_axis(&mut self, axis: u16, value: i32, now: Duration) -> Vec<&'static str> {
        match axis {
            code::ABS_X => self.stick_x = self.normalized_axis(axis, value),
            code::ABS_Y => self.stick_y = self.normalized_axis(axis, value),
            code::ABS_HAT0X => self.hat_x = value.signum(),
            code::ABS_HAT0Y => self.hat_y = value.signum(),
            _ => return Vec::new(),
        }
        self.update_stick_direction();
        self.reconcile_directions(now)
    }

    fn normalized_axis(&self, axis: u16, value: i32) -> f64 {
        self.ranges
            .get(&axis)
            .copied()
            .unwrap_or(AxisRange {
                minimum: i16::MIN.into(),
                maximum: i16::MAX.into(),
            })
            .normalize(value)
    }

    fn update_stick_direction(&mut self) {
        if let Some(active) = self.stick_direction {
            let magnitude = match active {
                Direction::Left => -self.stick_x,
                Direction::Right => self.stick_x,
                Direction::Up => -self.stick_y,
                Direction::Down => self.stick_y,
            };
            if magnitude >= STICK_RELEASE {
                return;
            }
        }

        let (direction, magnitude) = if self.stick_x.abs() >= self.stick_y.abs() {
            (
                if self.stick_x < 0.0 {
                    Direction::Left
                } else {
                    Direction::Right
                },
                self.stick_x.abs(),
            )
        } else {
            (
                if self.stick_y < 0.0 {
                    Direction::Up
                } else {
                    Direction::Down
                },
                self.stick_y.abs(),
            )
        };
        self.stick_direction = (magnitude >= STICK_ACTIVATE).then_some(direction);
    }

    fn desired_directions(&self) -> BTreeSet<Direction> {
        let mut directions = self.dpad_buttons.clone();
        if self.hat_x < 0 {
            directions.insert(Direction::Left);
        } else if self.hat_x > 0 {
            directions.insert(Direction::Right);
        }
        if self.hat_y < 0 {
            directions.insert(Direction::Up);
        } else if self.hat_y > 0 {
            directions.insert(Direction::Down);
        }
        if let Some(direction) = self.stick_direction {
            directions.insert(direction);
        }
        directions
    }

    fn reconcile_directions(&mut self, now: Duration) -> Vec<&'static str> {
        let desired = self.desired_directions();
        for released in self.active_directions.difference(&desired) {
            self.repeat_deadlines.remove(released);
        }
        let pressed = desired
            .difference(&self.active_directions)
            .copied()
            .collect::<Vec<_>>();
        for direction in &pressed {
            self.repeat_deadlines.insert(*direction, now + REPEAT_DELAY);
        }
        self.active_directions = desired;
        pressed.into_iter().map(Direction::key).collect()
    }

    fn repeat(&mut self, now: Duration) -> Vec<&'static str> {
        let mut keys = Vec::new();
        for direction in self.active_directions.iter().copied() {
            let Some(deadline) = self.repeat_deadlines.get_mut(&direction) else {
                continue;
            };
            if now >= *deadline {
                keys.push(direction.key());
                *deadline = now + REPEAT_INTERVAL;
            }
        }
        keys
    }
}

fn dpad_direction(button: u16) -> Option<Direction> {
    match button {
        code::BTN_DPAD_UP => Some(Direction::Up),
        code::BTN_DPAD_DOWN => Some(Direction::Down),
        code::BTN_DPAD_LEFT => Some(Direction::Left),
        code::BTN_DPAD_RIGHT => Some(Direction::Right),
        _ => None,
    }
}

fn button_key(button: u16) -> Option<&'static str> {
    match button {
        code::BTN_SOUTH => Some("Return"),
        code::BTN_EAST => Some("Escape"),
        code::BTN_TL => Some("F6"),
        code::BTN_TR => Some("F7"),
        code::BTN_START => Some("F8"),
        code::BTN_WEST => Some("F9"),
        code::BTN_NORTH => Some("F10"),
        _ => None,
    }
}

#[derive(Debug, Default)]
pub struct InputHub {
    devices: HashMap<String, DeviceState>,
}

impl InputHub {
    pub fn connect(&mut self, id: impl Into<String>, ranges: HashMap<u16, AxisRange>) {
        self.devices.insert(id.into(), DeviceState::new(ranges));
    }

    pub fn disconnect(&mut self, id: &str) {
        self.devices.remove(id);
    }

    pub fn connected_count(&self) -> usize {
        self.devices.len()
    }

    pub fn handle(&mut self, id: &str, event: InputEvent, now: Duration) -> Vec<&'static str> {
        self.devices
            .get_mut(id)
            .map_or_else(Vec::new, |device| device.handle(event, now))
    }

    pub fn repeat(&mut self, now: Duration) -> Vec<&'static str> {
        self.devices
            .values_mut()
            .flat_map(|device| device.repeat(now))
            .collect()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Health {
    Ready(String),
    Degraded(String),
    Unavailable(String),
}

pub fn evaluate_health(
    connected_count: usize,
    runtime_error: Option<&str>,
    input_error: Option<&str>,
) -> Health {
    if let Some(error) = runtime_error {
        return Health::Unavailable(error.to_owned());
    }
    if let Some(error) = input_error {
        return Health::Unavailable(error.to_owned());
    }
    if connected_count > 0 {
        Health::Ready(format!(
            "{connected_count} supported gamepad{} connected",
            if connected_count == 1 { "" } else { "s" }
        ))
    } else {
        Health::Degraded("No supported gamepad connected".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gamepad_capabilities() -> CapabilityDescriptor {
        CapabilityDescriptor {
            keys: [code::BTN_SOUTH, code::BTN_EAST, code::BTN_START]
                .into_iter()
                .collect(),
            axes: [code::ABS_X, code::ABS_Y].into_iter().collect(),
        }
    }

    fn ranges() -> HashMap<u16, AxisRange> {
        [
            (
                code::ABS_X,
                AxisRange {
                    minimum: -32_768,
                    maximum: 32_767,
                },
            ),
            (
                code::ABS_Y,
                AxisRange {
                    minimum: -32_768,
                    maximum: 32_767,
                },
            ),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn identifies_gamepads_by_capabilities() {
        assert!(gamepad_capabilities().is_supported_gamepad());
        assert!(
            !CapabilityDescriptor {
                keys: [code::BTN_SOUTH, code::BTN_EAST].into_iter().collect(),
                axes: HashSet::new(),
            }
            .is_supported_gamepad()
        );
        assert!(
            !CapabilityDescriptor {
                keys: HashSet::new(),
                axes: [code::ABS_X, code::ABS_Y].into_iter().collect(),
            }
            .is_supported_gamepad()
        );
    }

    #[test]
    fn normalizes_full_width_axis_ranges_without_overflow() {
        let range = AxisRange {
            minimum: i32::MIN,
            maximum: i32::MAX,
        };
        assert_eq!(range.normalize(i32::MIN), -1.0);
        assert_eq!(range.normalize(i32::MAX), 1.0);
        assert!(range.normalize(0).abs() < 1e-9);
    }

    #[test]
    fn maps_xbox_and_standard_buttons_and_deduplicates_presses() {
        let mut hub = InputHub::default();
        hub.connect("one", ranges());
        let now = Duration::ZERO;
        let cases = [
            (code::BTN_SOUTH, "Return"),
            (code::BTN_EAST, "Escape"),
            (code::BTN_TL, "F6"),
            (code::BTN_TR, "F7"),
            (code::BTN_START, "F8"),
            (code::BTN_WEST, "F9"),
            (code::BTN_NORTH, "F10"),
        ];
        for (button, key) in cases {
            assert_eq!(
                hub.handle(
                    "one",
                    InputEvent::Button {
                        code: button,
                        value: 1
                    },
                    now
                ),
                vec![key]
            );
            assert!(
                hub.handle(
                    "one",
                    InputEvent::Button {
                        code: button,
                        value: 2
                    },
                    now
                )
                .is_empty()
            );
        }
    }

    #[test]
    fn applies_stick_hysteresis_and_dominant_cardinal_direction() {
        let mut hub = InputHub::default();
        hub.connect("one", ranges());
        let now = Duration::ZERO;
        assert!(
            hub.handle(
                "one",
                InputEvent::Axis {
                    code: code::ABS_X,
                    value: 16_000
                },
                now
            )
            .is_empty()
        );
        assert_eq!(
            hub.handle(
                "one",
                InputEvent::Axis {
                    code: code::ABS_X,
                    value: 24_000
                },
                now
            ),
            vec!["Right"]
        );
        assert!(
            hub.handle(
                "one",
                InputEvent::Axis {
                    code: code::ABS_X,
                    value: 13_000
                },
                now
            )
            .is_empty()
        );
        assert!(
            hub.handle(
                "one",
                InputEvent::Axis {
                    code: code::ABS_X,
                    value: 5_000
                },
                now
            )
            .is_empty()
        );
        assert_eq!(
            hub.handle(
                "one",
                InputEvent::Axis {
                    code: code::ABS_Y,
                    value: -24_000
                },
                now
            ),
            vec!["Up"]
        );
    }

    #[test]
    fn repeats_directions_after_the_configured_delay() {
        let mut hub = InputHub::default();
        hub.connect("one", ranges());
        assert_eq!(
            hub.handle(
                "one",
                InputEvent::Button {
                    code: code::BTN_DPAD_LEFT,
                    value: 1
                },
                Duration::ZERO
            ),
            vec!["Left"]
        );
        assert!(hub.repeat(Duration::from_millis(349)).is_empty());
        assert_eq!(hub.repeat(Duration::from_millis(350)), vec!["Left"]);
        assert!(hub.repeat(Duration::from_millis(469)).is_empty());
        assert_eq!(hub.repeat(Duration::from_millis(470)), vec!["Left"]);
        hub.handle(
            "one",
            InputEvent::Button {
                code: code::BTN_DPAD_LEFT,
                value: 0,
            },
            Duration::from_millis(471),
        );
        assert!(hub.repeat(Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn keeps_multiple_devices_independent_across_disconnects() {
        let mut hub = InputHub::default();
        hub.connect("one", ranges());
        hub.connect("two", ranges());
        assert_eq!(hub.connected_count(), 2);
        hub.disconnect("one");
        assert_eq!(hub.connected_count(), 1);
        assert_eq!(
            hub.handle(
                "two",
                InputEvent::Button {
                    code: code::BTN_SOUTH,
                    value: 1
                },
                Duration::ZERO
            ),
            vec!["Return"]
        );
        assert!(
            hub.handle(
                "one",
                InputEvent::Button {
                    code: code::BTN_SOUTH,
                    value: 1
                },
                Duration::ZERO
            )
            .is_empty()
        );
    }

    #[test]
    fn runtime_failures_are_unavailable_and_recover() {
        assert_eq!(
            evaluate_health(1, Some("wtype failed"), None),
            Health::Unavailable("wtype failed".to_owned())
        );
        assert!(matches!(evaluate_health(1, None, None), Health::Ready(_)));
        assert!(matches!(
            evaluate_health(0, None, None),
            Health::Degraded(_)
        ));
    }
}
