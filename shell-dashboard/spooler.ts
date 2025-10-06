// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

// Sleep for given msec.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thin wrapper around spooler HTTP API.
 * Refer to docs/spec-spooler.md for details.
 */
export class SpoolerClient {
  private readonly host: string;

  /**
   * @param host base URL of the shell-spooler server
   */
  constructor(host: string) {
    this.host = host;
  }

  /**
   * Common RPC method for all HTTP API calls.
   * @param path - API endpoint path (e.g. "/get-ps")
   * @param req - Request body object to be JSON-encoded
   * @returns Parsed JSON response
   * @throws Error on HTTP errors
   */
  private async rpc(path: string, req: any): Promise<any> {
    const response = await fetch(`${this.host}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    return await response.json();
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
    await this.rpc('/write-line', { line: cleanCommand });
  }

  async cancel(): Promise<void> {
    await this.rpc('/cancel', {});
  }

  async getLatestPState(psName: string): Promise<{ time: number, pstate: Record<string, any> } | null> {
    const { pstates } = await this.rpc('/get-ps', { tag: psName, count: 1 });
    if (pstates.length === 0) {
      return null;
    }

    return {
      time: pstates[0].time,
      pstate: pstates[0].kv
    };
  }

  async setInit(lines: string[]): Promise<void> {
    await this.rpc('/set-init', { lines });
  }

  async getInit(): Promise<{ lines: string[] }> {
    return await this.rpc('/get-init', {});
  }

  async queryTS(start: Date, end: Date, step: number, keys: string[]): Promise<{ times: Date[]; values: Record<string, any[]> }> {
    // Convert Date objects to Unix timestamps
    const startUnix = start.getTime() / 1000;
    const endUnix = end.getTime() / 1000;

    const { times, values } = await this.rpc('/query-ts', {
      start: startUnix,
      end: endUnix,
      step: step,
      query: keys
    });

    const dates = times.map((ts: number) => new Date(ts * 1000));
    return {
      times: dates,
      values: values
    };
  }

  async addJob(commands: string[], signals: Record<string, number>): Promise<{ ok: boolean; job_id?: string }> {
    return await this.rpc('/add-job', {
      commands: commands,
      signals: signals
    });
  }

  async listJobs(): Promise<Array<{ job_id: string; status: 'WAITING' | 'RUNNING' | 'COMPLETED' | 'CANCELED'; time_added: Date; time_started?: Date; time_ended?: Date }>> {
    const { jobs } = await this.rpc('/list-jobs', {});

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
  }

  async getStatus(): Promise<{ busy: boolean; num_pending_commands: number; running_job?: string }> {
    return await this.rpc('/status', {});
  }

  async getErrors(count: number = 50): Promise<Array<{ time: Date; msg: string; src?: string }>> {
    const { pstates } = await this.rpc('/get-ps', { tag: "error", count });

    return pstates.map((ps: any) => ({
      time: new Date(ps.time * 1000),
      msg: ps.kv.msg,
      src: ps.kv.src
    }));
  }
}
