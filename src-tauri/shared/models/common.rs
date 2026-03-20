use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct CommandResult {
    pub success: bool,
    pub message: Option<String>,
}
