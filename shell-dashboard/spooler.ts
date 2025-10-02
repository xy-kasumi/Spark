// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @property api-offline - Spooler API not working
 * @property board-offline - API is OK, board response timed out (NOT IMPLEMENTED YET)
 * @property idle - API is OK, board is known to be idle state (ready to receive commands)
 * @property unknown - API is OK, board is in unknown state
 * @property busy - API is OK, board is known to be busy
 */
type SpoolerState = 'api-offline' | 'board-offline' | 'idle' | 'unknown' | 'busy';

/**
 * SpoolerController handles state check & command queue.
 */
class SpoolerController {
  private readonly host: string;
  private readonly pollIntervalMs: number;
  private readonly pingIntervalMs: number;

  private isPolling: boolean;

  private state: SpoolerState;

  public onUpdatePos: ((pos: Record<string, any>) => void) | null;
  public onUpdateStatus: ((state: SpoolerState, numQueuedCommands: number, runningJob: string | null) => void) | null;

  /**
   * @param host base URL of the shell-spooler server
   * @param pollIntervalMs API polling & state check interval in milliseconds
   * @param pingIntervalMs ping interval in milliseconds (must be multiples of pollMs)
   */
  constructor(host: string, pollIntervalMs = 100, pingIntervalMs = 5000) {
    this.host = host;
    this.pollIntervalMs = pollIntervalMs;
    this.pingIntervalMs = pingIntervalMs;

    this.isPolling = false;

    // Enhanced status tracking
    this.state = 'unknown';

    // Callbacks for UI updates
    this.onUpdatePos = null;
    this.onUpdateStatus = null;
  }

  /**
   * Start polling for new lines from the spooler
   */
  startPolling(): void {
    this.isPolling = true;
    this.pollPos();
    this.pollStatus();
  }

  /**
   * Stop polling
   */
  stopPolling(): void {
    this.isPolling = false;
  }

  private async pollPos(): Promise<void> {
    while (this.isPolling) {
      try {
        await this.sendPayload('?pos');
        const latestPos = await spoolerApi.getLatestPState(this.host, "pos");
        if (latestPos !== null) {
          this.onUpdatePos?.(latestPos.pstate);
        }
      } catch (error) {
        // squash
      }
      await this.delay(this.pingIntervalMs);
    }
  }

  private async pollStatus(): Promise<void> {
    while (this.isPolling) {
      try {
        const status = await spoolerApi.getStatus(this.host);
        this.state = status.busy ? 'busy' : 'idle';
        this.onUpdateStatus?.(this.state, status.num_pending_commands, status.running_job || null);
      } catch (error) {
        this.state = 'api-offline';
        this.onUpdateStatus?.(this.state, 0, null)
      }
      await this.delay(this.pollIntervalMs);
    }
  }

  async requestPosUpdate() {
    await this.delay(100); // hack to make request after command
    this.enqueueCommand('?pos');
  }

  /**
   * @returns Timestamp of enqueued
   */
  private async sendPayload(payload: string): Promise<string> {
    try {
      const response = await fetch(`${this.host}/write-line`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ line: payload })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const { time }: { time: string } = await response.json();
      return time;
    } catch (error) {
      // Command failed, set state to offline
      this.state = 'api-offline';
      throw error;
    }
  }

  async enqueueCommands(commands: string[]): Promise<void> {
    for (const command of commands) {
      await this.enqueueCommand(command);
    }
  }

  /**
   * Add a command to the queue
   * @param command - Command string to enqueue (ignores empty commands and G-code comments)
   */
  async enqueueCommand(command: string): Promise<void> {
    // Remove G-code style comments (everything after semicolon)
    const cleanCommand = command.split(';')[0].trim();
    if (cleanCommand.length > 100) {
      throw new Error("Command too long");
    }

    const response = await fetch(`${this.host}/write-line`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: cleanCommand })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  }

  /**
   * Clear the command queue and send cancel command
   */
  cancel(): void {
    // Send cancel
    fetch(`${this.host}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).catch(error => {
      console.log("cancel error", error);
    });
  }

  /**
   * Utility function to delay execution
   * @param ms - Milliseconds to delay
   * @returns Promise that resolves after delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Spooler API client for making HTTP requests to shell-spooler.
 * This is separate from SpoolerController and provides raw API access.
 */
const spoolerApi = {
  async getLatestPState(host: string, psName: string): Promise<{ time: number, pstate: Record<string, any> } | null> {
    const response = await fetch(`${host}/get-ps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: psName, count: 1 })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const { pstates } = await response.json();
    if (pstates.length === 0) {
      return null;
    }

    return {
      time: pstates[0].time,
      pstate: pstates[0].kv
    };
  },

  /**
   * Set init lines that will be sent to the core when spooler starts.
   * @param host - Base URL of the shell-spooler server
   * @param lines - Array of init line strings to persist
   */
  async setInit(host: string, lines: string[]): Promise<void> {
    const response = await fetch(`${host}/set-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  },

  /**
   * Get current init lines configuration.
   * @param host - Base URL of the shell-spooler server
   * @returns Array of configured init lines (empty if none configured)
   */
  async getInit(host: string): Promise<{ lines: string[] }> {
    const response = await fetch(`${host}/get-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.json();
  },

  async queryTS(host: string, start: Date, end: Date, step: number, keys: string[]): Promise<{ times: Date[]; values: Record<string, any[]> }> {
    // Convert Date objects to Unix timestamps
    const startUnix = start.getTime() / 1000;
    const endUnix = end.getTime() / 1000;

    const response = await fetch(`${host}/query-ts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: startUnix,
        end: endUnix,
        step: step,
        query: keys
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const { times, values } = await response.json();
    const dates = times.map((ts: number) => new Date(ts * 1000));
    return {
      times: dates,
      values: values
    };
  },

  async addJob(host: string, commands: string[], signals: Record<string, number>): Promise<{ ok: boolean; job_id?: string }> {
    const response = await fetch(`${host}/add-job`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: commands,
        signals: signals
      })
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return await response.json();
  },

  async listJobs(host: string): Promise<Array<{ job_id: string; status: 'WAITING' | 'RUNNING' | 'COMPLETED' | 'CANCELED'; time_added: Date; time_started?: Date; time_ended?: Date }>> {
    const response = await fetch(`${host}/list-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const jobs = (await response.json()).jobs;

    // Convert Unix timestamps to Date objects
    for (const job of jobs) {
      job.time_added = new Date(job.time_added * 1000);
      if (job.time_started !== undefined) {
        job.time_started = new Date(job.time_started * 1000);
      }
      if (job.time_ended !== undefined) {
        job.time_ended = new Date(job.time_ended * 1000);
      }
    }

    return jobs;
  },

  /**
   * Get spooler status summary.
   * @param host - Base URL of the shell-spooler server
   * @returns Status object containing busy state, pending commands count, and optional running job ID
   */
  async getStatus(host: string): Promise<{ busy: boolean; num_pending_commands: number; running_job?: string }> {
    const response = await fetch(`${host}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return await response.json();
  }
};

export { SpoolerController, spoolerApi };
