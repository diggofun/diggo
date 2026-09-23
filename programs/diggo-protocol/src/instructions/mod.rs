//! instructions module tree (phase 0a mechanical split).

use crate::*;

pub mod admin;
pub mod crank;
pub mod crew;
pub mod discovery;
pub mod fees;
pub mod launch;
pub mod mining;
pub mod token;
pub mod trade;

pub use admin::*;
pub use crank::*;
pub use crew::*;
pub use discovery::*;
pub use fees::*;
pub use launch::*;
pub use mining::*;
pub use token::*;
pub use trade::*;
