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

    // Ensure directories exist
    tokio::fs::create_dir_all(&config.workspace).await?;
    tokio::fs::create_dir_all(&config.session_dir).await?;

    // Check Pi is available on PATH
    if let Err(reason) = pi_runner::check_pi_auth().await {
        let path = std::env::var("PATH").unwrap_or_else(|_| "(unset)".into());
        tracing::error!(path = %path, "Pi check failed: {reason}");
        anyhow::bail!("Pi check failed: {reason}");
    }
    tracing::info!("Pi: OK");

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
