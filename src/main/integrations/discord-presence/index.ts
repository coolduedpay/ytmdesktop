import playerStateStore, { PlayerState, Thumbnail, VideoState } from "../../player-state-store";
import DiscordClient from "./minimal-discord-client";
import log from "electron-log";
import { DiscordActivityType } from "./minimal-discord-client/types";
import Integration from "../integration";
import memoryStore from "../../memory-store";

const DISCORD_CLIENT_ID = "1143202598460076053";

function getHighestResThumbnail(thumbnails: Thumbnail[]) {
  let currentWidth = 0;
  let currentHeight = 0;
  let url = null;
  for (const thumbnail of thumbnails) {
    if (thumbnail.width > currentWidth && thumbnail.height > currentHeight) {
      currentWidth = thumbnail.width;
      currentHeight = thumbnail.height;
      url = thumbnail.url;
    }
  }
  return url;
}

function getSmallImageKey(state: number) {
  // Developer Note:
  // You can add "-invert" to the end of the image key to invert (Black with White Border)
  switch (state) {
    case VideoState.Playing: {
      return "play-border";
    }

    case VideoState.Paused: {
      return "pause-border";
    }

    case VideoState.Buffering: {
      return "play-outline-border";
    }

    default: {
      return "pause-border";
    }
  }
}

function getSmallImageText(state: number) {
  switch (state) {
    case VideoState.Playing: {
      return "Playing";
    }

    case VideoState.Paused: {
      return "Paused";
    }

    case VideoState.Buffering: {
      return "Buffering";
    }

    default: {
      return "Unknown";
    }
  }
}

function stringLimit(str: string, limit: number, minimum: number) {
  if (str.length > limit) {
    return str.substring(0, limit - 3) + "...";
  }

  if (str.length < minimum) {
    return str.padEnd(minimum, "​"); // There's a zero width space here
  }

  return str;
}

export default class DiscordPresence extends Integration {
  public name = "DiscordPresence";
  public storeEnableProperty: Integration["storeEnableProperty"] = "integrations.discordPresenceEnabled";

  private discordClient: DiscordClient = null;
  private ready = false;
  private connectionRetryTimeout: string | number | NodeJS.Timeout = null;
  private pauseTimeout: string | number | NodeJS.Timeout = null;
  private endTimestamp: number | null = null;
  private stateCallback: (event: PlayerState) => void = null;

  private lastTimeSeconds: number | null = null;
  private lastDuration: number | null = null;

  private lastEndTimestamp: number | null = null;
  private lastVideoDetailsTitle: string | null = null;
  private lastVideoDetailsAuthor: string | null = null;
  private lastVideoDetailsId: string | null = null;
  private lastTrackState: VideoState | null = null;

  private connectionRetries: number = 0;

  private playerStateChanged(state: PlayerState) {
    if (this.ready && state.videoDetails) {
      const date = Date.now();
      const timeSeconds = Math.floor(date / 1000);
      const videoProgress = Math.floor(state.videoProgress);
      const duration = state.videoDetails.durationSeconds - videoProgress;

      let adjustedTimeSeconds = timeSeconds;

      if (!this.lastTimeSeconds) this.lastTimeSeconds = timeSeconds;
      if (!this.lastDuration) this.lastDuration = duration;
      if (timeSeconds - this.lastTimeSeconds > 0) {
        if (this.lastDuration === duration) {
          // The time changed seconds but the duration hasn't. We use the old timestamp to prevent weird deviations
          adjustedTimeSeconds = this.lastTimeSeconds;
        } else {
          this.lastDuration = duration;
          this.lastTimeSeconds = timeSeconds;
        }
      } else {
        this.lastDuration = duration;
        this.lastTimeSeconds = timeSeconds;
      }

      this.endTimestamp = state.trackState === VideoState.Playing ? adjustedTimeSeconds + (state.videoDetails.durationSeconds - videoProgress) : undefined;
      if (
        this.lastEndTimestamp !== this.endTimestamp ||
        state.videoDetails.title !== this.lastVideoDetailsTitle ||
        state.videoDetails.author !== this.lastVideoDetailsAuthor ||
        state.videoDetails.id !== this.lastVideoDetailsId ||
        state.trackState !== this.lastTrackState
      ) {
        this.lastEndTimestamp = this.endTimestamp;
        this.lastVideoDetailsTitle = state.videoDetails.title;
        this.lastVideoDetailsAuthor = state.videoDetails.author;
        this.lastVideoDetailsId = state.videoDetails.id;
        this.lastTrackState = state.trackState;

        const thumbnail = getHighestResThumbnail(state.videoDetails.thumbnails);
        this.discordClient.setActivity({
          // Discord not accepts Listening + Progress, but you MUST include Start + End (to know the progress)
          type: DiscordActivityType.Listening,
          details: stringLimit(state.videoDetails.title, 128, 2),
          state: stringLimit(state.videoDetails.author, 128, 2),
          timestamps: {
            start: state.trackState === VideoState.Playing ? adjustedTimeSeconds - videoProgress : undefined,
            end: state.trackState === VideoState.Playing ? this.endTimestamp : undefined
          },
          assets: {
            large_image: thumbnail && thumbnail.length <= 256 ? thumbnail : "ytmd-logo",
            large_text: stringLimit(state.videoDetails.title, 128, 2),
            small_image: getSmallImageKey(state.trackState),
            small_text: getSmallImageText(state.trackState)
          },
          instance: false,
          buttons: [
            {
              label: "Play on YouTube Music",
              url: `https://music.youtube.com/watch?v=${state.videoDetails.id}`
            },
            {
              label: "Play on YouTube Music Desktop",
              url: `ytmd://play/${state.videoDetails.id}`
            }
          ]
        });
      }

      if (state.trackState === VideoState.Buffering || state.trackState === VideoState.Paused || state.trackState === VideoState.Unknown) {
        if (this.pauseTimeout) {
          clearTimeout(this.pauseTimeout);
          this.pauseTimeout = null;
        }

        this.pauseTimeout = setTimeout(() => {
          if (this.discordClient && this.ready) {
            this.discordClient.clearActivity();
          }
          this.pauseTimeout = null;
        }, 30 * 1000);
      } else {
        if (this.pauseTimeout) {
          clearTimeout(this.pauseTimeout);
          this.pauseTimeout = null;
        }
      }
    } else if (this.ready && !state.videoDetails) {
      this.discordClient.clearActivity();
    }
  }

  private retryDiscordConnection() {
    log.info(`Connecting to Discord attempt ${this.connectionRetries}/30`);
    if (this.isEnabled) {
      if (this.connectionRetries < 30) {
        this.connectionRetries++;
        this.connectionRetryTimeout = setTimeout(() => {
          if (this.discordClient) {
            this.discordClient.connect().catch(() => this.retryDiscordConnection());
          }
        }, 5 * 1000);
      } else {
        memoryStore.set("discordPresenceConnectionFailed", true);
      }
    }
  }

  public onEnabled(): void {
    if (!this.discordClient) {
      this.discordClient = new DiscordClient(DISCORD_CLIENT_ID);

      this.discordClient.on("connect", () => {
        this.ready = true;
        this.connectionRetries = 0;
        memoryStore.set("discordPresenceConnectionFailed", false);
      });
      this.discordClient.on("close", () => {
        log.info("Discord connection closed");
        this.ready = false;
        this.retryDiscordConnection();
      });
      this.discordClient.connect().catch(() => this.retryDiscordConnection());
      this.stateCallback = event => {
        this.playerStateChanged(event);
      };
      playerStateStore.addEventListener(this.stateCallback);
    }
  }

  public onDisabled(): void {
    this.connectionRetries = 0;
    memoryStore.set("discordPresenceConnectionFailed", false);
    if (this.connectionRetryTimeout) {
      clearTimeout(this.connectionRetryTimeout);
      this.connectionRetryTimeout = null;
    }
    if (this.discordClient) {
      this.ready = false;
      this.discordClient.destroy();
      this.discordClient = null;
    }
    if (this.stateCallback) {
      playerStateStore.removeEventListener(this.stateCallback);
    }
  }
}
