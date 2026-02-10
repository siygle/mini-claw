mod bot;
mod config;
mod error;
mod file_detector;
mod markdown;
mod pi_runner;
mod rate_limiter;
mod sessions;
mod workspace;

use anyhow::Result;
use teloxide::prelude::*;
use teloxide::utils::command::BotCommands;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    tracing::info!("Mini-Claw starting...");

    // Load configuration
    let config = config::load_config()?;
    tracing::info!(workspace = %config.workspace.display(), "Workspace configured");
    tracing::info!(session_dir = %config.session_dir.display(), "Session dir configured");
    tracing::info!(pi_path = %config.pi_path, "Pi binary resolved");

    // Ensure directories exist
    tokio::fs::create_dir_all(&config.workspace).await?;
    tokio::fs::create_dir_all(&config.session_dir).await?;

    // Check Pi readiness (lightweight filesystem checks, no subprocess)
    match pi_runner::check_pi_readiness(&config.pi_path).await {
        pi_runner::PiReadiness::Ready => {
            tracing::info!("Pi: OK (binary found, auth present)");
        }
        pi_runner::PiReadiness::BinaryNotFound(path) => {
            anyhow::bail!("Pi binary not found at: {path}. Set PI_PATH or install Pi.");
        }
        #[cfg(unix)]
        pi_runner::PiReadiness::BinaryNotExecutable(path) => {
            anyhow::bail!("Pi binary not executable: {path}. Run: chmod +x {path}");
        }
        pi_runner::PiReadiness::AuthFileMissing => {
            tracing::warn!("Pi auth file (~/.pi/agent/auth.json) not found. Run 'pi /login' if not authenticated. Continuing startup...");
        }
    }

    // Diagnostic: try pi --version and log the actual result for debugging
    match tokio::process::Command::new(&config.pi_path)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
    {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            if output.status.success() {
                tracing::info!(version = stdout.trim(), "Pi version check passed");
            } else {
                tracing::warn!(
                    exit_code = ?output.status.code(),
                    stdout = stdout.trim(),
                    stderr = stderr.trim(),
                    "Pi version check failed (bot will continue, errors may appear per-message)"
                );
            }
        }
        Err(e) => {
            tracing::warn!(error = %e, pi_path = %config.pi_path, "Failed to spawn pi --version (bot will continue)");
        }
    }

    // Build shared state
    let state = bot::AppState::new(config.clone());

    // Create bot
    let bot = Bot::new(&config.telegram_token);

    // Register commands with Telegram
    if let Err(e) = bot
        .set_my_commands(bot::commands::BotCommand::bot_commands())
        .await
    {
        tracing::warn!("Failed to set bot commands: {e}");
    }

    tracing::info!("Bot starting...");

    // Build and run dispatcher
    bot::build_and_run(bot, state).await;

    Ok(())
}
