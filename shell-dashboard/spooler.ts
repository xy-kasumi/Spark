// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

interface LogLine {
    line_num: number;
    dir: 'up' | 'down';
    content: string;
    time: string;
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
    private readonly apiIntervalMs: number;
    private readonly pingIntervalMs: number;

    private isPolling: boolean;

    private commandQueue: string[];

    private state: SpoolerState;
    private statusText: string;
    
    public onUpdate: ((state: SpoolerState, status: string) => void) | null;
    public onQueueChange: (() => void) | null;

    /**
     * @param host base URL of the shell-spooler server
     * @param pollMs API polling & state check interval in milliseconds
     * @param pingIntervalMs ping interval in milliseconds (must be multiples of pollMs)
     */
    constructor(host: string, pollMs = 500, pingIntervalMs = 5000) {
        this.host = host;
        this.apiIntervalMs = pollMs;
        this.pingIntervalMs = pingIntervalMs;

        this.commandQueue = [];

        this.isPolling = false;
        
        // Enhanced status tracking
        this.state = 'unknown';
        this.statusText = '';
        
        // Callbacks for UI updates
        this.onUpdate = null;
        this.onQueueChange = null;
    }
    
    /**
     * Set state and notify callback
     * @param newState - New state value
     * @param newStatus - Optional status text
     */
    private setState(newState: SpoolerState, newStatus?: string): void {
        const stateChanged = this.state !== newState;
        const statusChanged = newStatus !== undefined && this.statusText !== newStatus;
        
        if (stateChanged) {
            this.state = newState;
        }
        if (statusChanged) {
            this.statusText = newStatus!;
        }
        
        if ((stateChanged || statusChanged) && this.onUpdate) {
            this.onUpdate(this.state, this.statusText);
        }
    }
    
    
    /**
     * Start polling for new lines from the spooler
     */
    startPolling(): void {
        this.isPolling = true;
        this.pollLoop(this.apiIntervalMs);
    }
    
    /**
     * Stop polling
     */
    stopPolling(): void {
        this.isPolling = false;
    }
    
    /**
     * Internal polling loop
     * @param intervalMs - Polling interval in milliseconds
     */
    private async pollLoop(intervalMs: number): Promise<void> {
        let pingCounter = 0;
        const pingInterval = Math.floor(this.pingIntervalMs / intervalMs);
        
        while (this.isPolling) {
            await this.fetchNewLines();
            
            // Process commands only when idle
            if (this.state === 'idle') {
                await this.processCommandQueue();
            }
            
            // Handle ping timing for appropriate states  
            pingCounter++;
            if (pingCounter >= pingInterval) {
                if ((this.state === 'idle' || this.state === 'unknown' || this.state === 'board-offline') && 
                    this.commandQueue.length === 0) {
                    await this.sendCommand('ping', true);
                }
                pingCounter = 0;
            }
            
            await this.delay(intervalMs);
        }
    }
    
    /**
     * Fetch new lines from the spooler
     */
    private async fetchNewLines(): Promise<void> {
        try {
            const response = await fetch(`${this.host}/query-lines`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tail: 1
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const { lines, count, now }: { lines: LogLine[], count: number, now: string } = await response.json();

            if (count === 0) {
                this.setState('unknown');
            } else {
                const line = lines[lines.length - 1];
                if (line.dir === 'down') {
                    if (line.content.startsWith('!')) {
                        this.setState('unknown');
                    } else {
                        this.setState('busy');
                    }
                } else {
                    const isIdle = line.content.startsWith('I');
                    if (isIdle) {
                        this.setState('idle', this.parseStatus(line.content));
                    } else {
                        this.setState('busy');
                    }
                }
            }
        } catch (error) {
            this.setState('api-offline');
            console.log("spooler error", error);
        }
    }
    
    /**
     * Parse machine status from "I ready ..." lines
     * @param line - Status line content
     * @returns Status text or null if not parseable
     */
    private parseStatus(line: string): string | null {
        if (line.startsWith('I ready ')) {
            return line.substring(8).trim();
        }
        return null;
    }
    
    /**
     * Process command queue (assumes state check already done)
     */
    private async processCommandQueue(): Promise<void> {
        if (this.commandQueue.length === 0) {
            return;
        }
        
        const command = this.commandQueue.shift();
        if (this.onQueueChange) {
            this.onQueueChange();
        }
        await this.sendCommand(command, false);
    }
    
    /**
     * Send a command to the spooler
     * @param command - Command to send
     * @param isHealthcheck - Whether this is an auto-initiated healthcheck
     */
    private async sendCommand(command: string, isHealthcheck: boolean): Promise<void> {
        try {
            const response = await fetch(`${this.host}/write-line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: command })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            // Set appropriate busy state
            this.setState(isHealthcheck ? 'busy-healthcheck' : 'busy');
        } catch (error) {
            // Command failed, set state to offline
            this.setState('api-offline');
        }
    }
    
    /**
     * Add a command to the queue
     * @param command - Command string to enqueue (ignores empty commands and G-code comments)
     */
    enqueueCommand(command: string): void {
        // Remove G-code style comments (everything after semicolon)
        const withoutComment = command.split(';')[0].trim();
        
        if (withoutComment.length > 0) {
            this.commandQueue.push(withoutComment);
            if (this.onQueueChange) {
                this.onQueueChange();
            }
        }
    }
    
    /**
     * Get a copy of the current command queue
     * @returns Array of queued command strings
     */
    peekQueue(): string[] {
        return [...this.commandQueue];
    }
    
    /**
     * Clear the command queue and send cancel command
     */
    cancel(): void {
        // Clear queue
        this.commandQueue.length = 0;
        if (this.onQueueChange) {
            this.onQueueChange();
        }
        
        // Send cancel command directly
        fetch(`${this.host}/write-line`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ line: '!' })
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
 * Calculates Adler-32 checksum for binary data.
 * @param data - Binary data to checksum
 * @returns 32-bit unsigned checksum
 */
function calculateAdler32(data: Uint8Array): number {
    let a = 1, b = 0;
    const MOD_ADLER = 65521;

    for (let i = 0; i < data.length; i++) {
        a = (a + data[i]) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }

    return ((b << 16) | a) >>> 0;
}

/**
 * Parses ">blob <base64> <checksum>" line and validates payload.
 * @param blobLine - Line containing ">blob <base64> <checksum>"
 * @returns Verified binary payload
 * @throws On invalid format or checksum mismatch
 */
function parseBlobPayload(blobLine: string): Uint8Array {
    const parts = blobLine.split(' ');
    if (parts.length < 3 || parts[0] !== ">blob") {
        throw new Error("Invalid blob format");
    }

    const base64Payload = parts[1];
    const expectedChecksum = parts[2];

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

    // verify checksum
    const actualChecksum = calculateAdler32(binaryData);
    if (actualChecksum.toString(16).padStart(8, '0') !== expectedChecksum) {
        throw new Error("Checksum mismatch");
    }

    return binaryData;
}

/**
 * Spooler API client for making HTTP requests to shell-spooler.
 * This is separate from SpoolerController and provides raw API access.
 */
const spoolerApi = {
    /**
     * Query log lines from the spooler.
     * @param host - Base URL of the shell-spooler server
     * @param params - Query parameters (tail, from_line, to_line)
     * @returns Response with count, lines array, and timestamp
     */
    async queryLines(host: string, params: { tail?: number; from_line?: number; to_line?: number }): Promise<{ count: number; lines: LogLine[]; now: string }> {
        const response = await fetch(`${host}/query-lines`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        return await response.json();
    },
    
    /**
     * Get the last blob from upward (machine response) log lines.
     * @param host - Base URL of the shell-spooler server
     * @param tail - Number of lines to query (default: 100)
     * @returns Parsed blob data or null if not found
     */
    async getLastUpBlob(host: string, tail: number = 100): Promise<Uint8Array | null> {
        try {
            const result = await this.queryLines(host, { tail });
            
            // Find the last line with dir="up" that starts with ">blob"
            for (let i = result.lines.length - 1; i >= 0; i--) {
                const line = result.lines[i];
                if (line.dir === 'up' && line.content.startsWith('>blob')) {
                    try {
                        return parseBlobPayload(line.content);
                    } catch (e) {
                        console.error('Failed to parse blob:', e);
                        return null;
                    }
                }
            }
            
            return null;
        } catch (error) {
            console.error('Failed to query lines:', error);
            return null;
        }
    }
};
