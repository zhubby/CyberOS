pub mod adapters;
pub mod application;
pub mod domain;
pub mod error;
pub mod ports;
pub mod runtime;

pub use domain::config::AlerterConfig;
pub use runtime::service::AlerterService;
