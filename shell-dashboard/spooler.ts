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
 */
type SpoolerState = 'api-offline' | 'board-offline' | 'idle' | 'unknown' | 'busy';

/**
 * SpoolerController handles state check & command queue.
 */
class SpoolerController {
    private readonly host: string;
    private readonly apiIntervalMs: number;
    private readonly pingIntervalMs: number;

    private pingTimer: number | null;
    private isPolling: boolean;

    private commandQueue: string[];

    private state: SpoolerState;
    private statusText: string;
    
    public onUpdate: ((state: SpoolerState, status: string) => void) | null;

    /**
     * @param host base URL of the shell-spooler server
     * @param apiIntervalMs API polling interval in milliseconds
     * @param pingIntervalMs ping interval in milliseconds
     * @param commandTimeoutMs command timeout in milliseconds
     */
    constructor(host: string, apiIntervalMs = 500, pingIntervalMs = 5000, commandTimeoutMs = 1000) {
        this.host = host;
        this.apiIntervalMs = apiIntervalMs;
        this.pingIntervalMs = pingIntervalMs;

        this.commandQueue = [];

        this.isPolling = false;
        this.pingTimer = null;
        
        // Enhanced status tracking
        this.state = 'unknown';
        this.statusText = '';
        
        // Callbacks for UI updates
        this.onUpdate = null;
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
        this.startPingLoop();
    }
    
    /**
     * Stop polling
     */
    stopPolling(): void {
        this.isPolling = false;
        this.stopPingLoop();
    }
    
    /**
     * Internal polling loop
     * @param intervalMs - Polling interval in milliseconds
     */
    private async pollLoop(intervalMs: number): Promise<void> {
        while (this.isPolling) {
            await this.fetchNewLines();
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
                    this.setState('busy');
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
        
        // Process command queue if state allows
        await this.processCommandQueue();
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
     * Process command queue if state is idle and queue has commands
     */
    private async processCommandQueue(): Promise<void> {
        if (this.state !== 'idle' || this.commandQueue.length === 0) {
            return;
        }
        
        const command = this.commandQueue.shift();
        if (!command) {
            return;
        }
        
        try {
            const response = await fetch(`${this.host}/write-line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: command })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Command sent successfully, state will be updated by polling
        } catch (error) {
            // Command failed, set state to offline
            this.setState('api-offline');
        }
    }
    
    
    /**
     * Add a command to the queue
     * @param command - Command string to enqueue
     */
    enqueueCommand(command: string): void {
        this.commandQueue.push(command);
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
     * Check if commands are currently being executed
     * @returns True if commands are being executed
     */
    isExecuting(): boolean {
        return this.commandQueue.length > 0;
    }
    
    /**
     * Start the ping loop for keeping connection alive
     */
    private startPingLoop(): void {
        this.stopPingLoop(); // Clear any existing timer
        this.pingTimer = setInterval(() => {
            this.sendPingIfNeeded();
        }, this.pingIntervalMs);
    }
    
    /**
     * Stop the ping loop
     */
    private stopPingLoop(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }
    
    /**
     * Send ping command if in appropriate state
     */
    private async sendPingIfNeeded(): Promise<void> {
        // Only ping in idle, unknown, or board-offline states
        if (this.state === 'idle' || this.state === 'unknown' || this.state === 'board-offline') {
            // Add ping to queue - it will be processed when state is idle
            this.enqueueCommand('ping');
        }
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
