// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

interface LogLine {
    line_num: number;
    dir: 'up' | 'down';
    content: string;
    time: Date;
}

/**
 * @property api-offline - Spooler API not working
 * @property board-offline - API is OK, board response timed out (NOT IMPLEMENTED YET)
 * @property idle - API is OK, board is known to be idle state (ready to receive commands)
 * @property unknown - API is OK, board is in unknown state
 * @property busy - API is OK, board is known to be busy (or probably busy)
 * @property busy-healthcheck - API is OK, board is busy due to auto-initiated ping
 */
type SpoolerState = 'api-offline' | 'board-offline' | 'idle' | 'unknown' | 'busy' | 'busy-healthcheck';

/**
 * SpoolerController handles state check & command queue.
 */
class SpoolerController {
    private readonly host: string;
    private readonly pollIntervalMs: number;
    private readonly pingIntervalMs: number;

    private isPolling: boolean;
    private requestPos: boolean = false;

    private state: SpoolerState;

    public onUpdate: ((state: SpoolerState, status: Record<string, any>) => void) | null;
    public onQueueChange: (() => void) | null;
    public onReboot: (() => void) | null;

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
        this.onUpdate = null;
        this.onQueueChange = null;
        this.onReboot = null;
    }

    /**
     * Start polling for new lines from the spooler
     */
    startPolling(): void {
        this.isPolling = true;
        this.pollLoop();
    }

    /**
     * Stop polling
     */
    stopPolling(): void {
        this.isPolling = false;
    }

    /**
     * Internal polling loop
     */
    private async pollLoop(): Promise<void> {
        let lastPingTime = Date.now();
        while (this.isPolling) {
            if (this.requestPos || Date.now() - lastPingTime >= this.pingIntervalMs) {
                this.requestPos = false;
                await this.sendCommand('?pos', true);
                lastPingTime = Date.now();
            }

            const latestPos = await spoolerApi.getLatestPState(this.host, "pos");
            if (latestPos !== null) {
                this.state = "idle";
                this.onUpdate(this.state, latestPos.pstate);
            }

            await this.delay(this.pollIntervalMs);
        }
    }

    async requestPosUpdate() {
        await this.delay(100); // hack to make request after command
        this.requestPos = true;
    }

    /**
     * Handle board reboot detection
     */
    private handleReboot(): void {
        // Cancel pending commands
        if (this.onQueueChange) {
            this.onQueueChange();
        }

        if (this.onReboot) {
            this.onReboot();
        }
    }

    /**
     * Send a command to the spooler
     * @param command - Command to send
     * @param isHealthcheck - Whether this is an auto-initiated healthcheck
     * @returns Timestamp of enqueued
     */
    private async sendCommand(command: string, isHealthcheck: boolean): Promise<string> {
        try {
            const response = await fetch(`${this.host}/write-line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: command })
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const { time }: { time: string } = await response.json();

            // Set appropriate busy state
            this.state = isHealthcheck ? 'busy-healthcheck' : 'busy';
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

        const response = await fetch(`${host}/write-line`, {
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
        // Clear queue
        if (this.onQueueChange) {
            this.onQueueChange();
        }

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
 * Parses "blob <base64>" line and validates payload.
 * @param blobLine - Line containing "blob <base64>"
 * @returns Verified binary payload
 * @throws On invalid format or checksum mismatch
 */
function parseBlobPayload(blobLine: string): Uint8Array {
    const parts = blobLine.split(' ');
    if (parts.length != 2 || parts[0] !== "blob") {
        throw new Error("Invalid blob format");
    }

    const base64Payload = parts[1];

    // decode base64 payload (URL-safe without padding)
    let binaryData: Uint8Array;
    try {
        const standardBase64 = base64Payload.replace(/-/g, '+').replace(/_/g, '/');
        const binaryString = atob(standardBase64);
        binaryData = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            binaryData[i] = binaryString.charCodeAt(i);
        }
    } catch (e) {
        throw new Error("Failed to decode base64: " + e.message);
    }

    return binaryData;
}

/**
 * Spooler API client for making HTTP requests to shell-spooler.
 * This is separate from SpoolerController and provides raw API access.
 */
const spoolerApi = {
    psLatestBeginLines: new Map<string, number>(),

    /**
     * Query log lines from the spooler.
     * @param host - Base URL of the shell-spooler server
     * @param params - Query parameters (tail, from_line, to_line, filter_dir, filter_regex)
     * @returns Response with count, lines array, and timestamp
     */
    async queryLines(host: string, params: { tail?: number; from_line?: number; to_line?: number; filter_dir?: "up" | "down"; filter_regex?: string }): Promise<{ count: number; lines: LogLine[]; now: number }> {
        const response = await fetch(`${host}/query-lines`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const result = await response.json();

        // Convert Unix timestamps to Date objects
        if (result.lines) {
            for (const line of result.lines) {
                line.time = new Date(line.time * 1000); // Convert Unix timestamp to Date
            }
        }

        return result;
    },

    async getLatestPState(host: string, psName: string): Promise<{ beginTime: number, pstate: Record<string, any> } | null> {
        const latestBeginLine = this.psLatestBeginLines.get(psName) || 1;
        const beginLineRes = await spoolerApi.queryLines(host, {
            from_line: latestBeginLine,
            filter_dir: "up",
            filter_regex: `^${psName} <.*$`
        });
        const endLineRes = await spoolerApi.queryLines(host, {
            from_line: latestBeginLine,
            filter_dir: "up",
            filter_regex: `^${psName} .*>$`
        });

        if (beginLineRes.count === 0 || endLineRes.count === 0) {
            return null;
        }

        const beginLine = beginLineRes.lines[beginLineRes.lines.length - 1];
        const endLine = endLineRes.lines[endLineRes.lines.length - 1];
        if (endLine.line_num < beginLine.line_num) {
            return null; // mid-transfer (seeing previous ">" and ongoing p-state "<")
        }

        const content = await spoolerApi.queryLines(host, {
            from_line: beginLine.line_num,
            to_line: endLine.line_num + 1,
            filter_dir: "up",
            filter_regex: `^${psName} `
        });

        let pstate: Record<string, any>;
        for (const line of content.lines) {
            const content = line.content;
            for (let item of content.substring(`${psName} `.length).split(' ')) {
                item = item.trim();
                if (item === "<") {
                    pstate = {};
                } else if (item === ">") {
                    break;
                } else {
                    const [key, value] = item.split(":");
                    if (value === "true") {
                        pstate[key] = true;
                    } else if (value === "false") {
                        pstate[key] = false;
                    } else if (value.startsWith('"')) {
                        // TODO: unescape
                        pstate[key] = value.substring(1, value.length - 1);
                    } else {
                        const maybeNum = parseFloat(value) as number;
                        if (!isNaN(maybeNum)) {
                            pstate[key] = maybeNum;
                        } else {
                            console.warn(`Ignoring invalid pstate item: key=${key}, value=${value}`);
                        }
                    }
                }
            }
        }
        if (pstate === undefined) {
            console.warn("broken pstate; '<' not found. Highly likely a bug.");
            return null;
        }
        this.psLatestBeginLines.set(psName, beginLine.line_num);
        return { beginTime: beginLine.time.getTime() / 1000, pstate };
    },

    /**
     * Get the last blob from upward (machine response) log lines.
     * @param host - Base URL of the shell-spooler server
     * @returns Parsed blob data or null if not found
     */
    async getLastUpBlob(host: string): Promise<Uint8Array | null> {
        try {
            const result = await this.queryLines(host, {
                filter_dir: "up",
                filter_regex: "^blob"
            });
            if (result.lines.length === 0) {
                return null;
            }

            // Get the last line
            const lastBlobLine = result.lines[result.lines.length - 1];
            try {
                return parseBlobPayload(lastBlobLine.content);
            } catch (e) {
                console.error('Failed to parse blob:', e);
                return null;
            }
        } catch (error) {
            console.error('Failed to query lines:', error);
            return null;
        }
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

        const {times, values} = await response.json();
        const dates = times.map((ts: number) => new Date(ts * 1000));
        return {
            times: dates,
            values: values
        };
    }
};
