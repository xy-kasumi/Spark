// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

interface LogLine {
    line_num: number;
    dir: 'up' | 'down';
    content: string;
    time: string;
}

interface SpoolerStatus {
    x?: number;
    y?: number;
    z?: number;
    state: SpoolerState;
}

interface QueuedCommand {
    command: string;
    resolve: (value: string) => void;
    reject: (reason: Error) => void;
}

/**
 * @property api-offline - Spooler API not working
 * @property board-offline - API is OK, board response timed out
 * @property idle - API is OK, board is known to be idle state (ready to receive commands)
 * @property unknown - API is OK, board is in unknown state
 * @property busy - API is OK, board is known to be busy (or probably busy)
 */
type SpoolerState = 'api-offline' | 'board-offline' | 'idle' | 'unknown' | 'busy';

/**
 * SpoolerClient handles all communication with shell-spooler using the new line-based API.
 * It manages command queuing, device readiness, and protocol parsing with enhanced status tracking.
 */
class SpoolerClient {
    private host: string;
    private apiIntervalMs: number;
    private commandQueue: QueuedCommand[];
    private currentCommand: QueuedCommand | null;
    private deviceReady: boolean;
    private lastLineNum: number;
    private isPolling: boolean;
    private status: SpoolerState;
    private lastCommandTime: number | null;
    private lastResponseTime: number | null;
    private pingIntervalMs: number;
    private commandTimeoutMs: number;
    private pingTimer: number | null;
    
    public onStatusUpdate: ((status: SpoolerStatus) => void) | null;
    public onLogLine: ((line: LogLine) => void) | null;
    public onStatusChange: ((newStatus: SpoolerState, oldStatus: SpoolerState) => void) | null;
    public onError: ((error: Error) => void) | null;

    /**
     * @param host base URL of the shell-spooler server
     * @param apiIntervalMs API polling interval in milliseconds
     * @param pingIntervalMs ping interval in milliseconds
     * @param commandTimeoutMs command timeout in milliseconds
     */
    constructor(host: string, apiIntervalMs = 500, pingIntervalMs = 5000, commandTimeoutMs = 1000) {
        this.host = host;
        this.apiIntervalMs = apiIntervalMs;
        this.commandQueue = [];
        this.currentCommand = null;
        this.deviceReady = true;
        this.lastLineNum = 0;
        this.isPolling = false;
        
        // Enhanced status tracking
        this.status = 'unknown';
        this.lastCommandTime = null;
        this.lastResponseTime = null;
        this.pingIntervalMs = pingIntervalMs;
        this.commandTimeoutMs = commandTimeoutMs;
        this.pingTimer = null;
        
        // Callbacks for UI updates
        this.onStatusUpdate = null;
        this.onLogLine = null;
        this.onStatusChange = null;
        this.onError = null;
    }
    
    /**
     * Set status and notify if changed
     * @param newStatus - New status value
     */
    private setStatus(newStatus: SpoolerState): void {
        if (this.status !== newStatus) {
            const oldStatus = this.status;
            this.status = newStatus;
            if (this.onStatusChange) {
                this.onStatusChange(newStatus, oldStatus);
            }
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
                    line_num_since: this.lastLineNum + 1,
                    num_lines: 100
                })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const { lines, now }: { lines: LogLine[], now: string } = await response.json();
            
            // Check for board timeout if we have a pending command
            if (this.currentCommand && this.lastCommandTime) {
                const serverTime = new Date(now).getTime();
                const commandAge = serverTime - this.lastCommandTime;
                if (commandAge > this.commandTimeoutMs) {
                    this.setStatus('board-offline');
                }
            }
            
            // Process lines and update status based on responses
            let hasStatusInfo = false;
            for (const line of lines) {
                this.processLine(line);
                this.lastLineNum = line.line_num;
                
                // Track if we got status information from board
                if (line.dir === 'down' && line.content.startsWith('I')) {
                    hasStatusInfo = true;
                    this.lastResponseTime = new Date(line.time).getTime();
                }
            }
            
            // If API is working but no status info, we're in unknown state
            if (!hasStatusInfo && this.status === 'unknown') {
                // Stay in unknown state
            } else if (hasStatusInfo && (this.status === 'unknown' || this.status === 'board-offline')) {
                // We got status info, update accordingly
                this.setStatus(this.deviceReady ? 'idle' : 'busy');
            }
            
            // API is working
            if (this.status === 'api-offline') {
                this.setStatus('unknown');
            }
            
        } catch (error) {
            this.setStatus('api-offline');
            console.log("spooler error", error);
        }
    }
    
    /**
     * Process a single line from the spooler
     * @param line - Line object with line_num, dir, content, time
     */
    private processLine(line: LogLine): void {
        // Notify UI of new log line
        if (this.onLogLine) {
            this.onLogLine(line);
        }
        
        // Handle device responses (lines from device to host)
        if (line.dir === 'down' && line.content.startsWith('I')) {
            this.deviceReady = true;
            this.setStatus('idle');
            
            // Parse and notify status update
            const status = this.parseStatus(line.content);
            if (status && this.onStatusUpdate) {
                this.onStatusUpdate(status);
            }
            
            // Complete current command
            if (this.currentCommand) {
                this.currentCommand.resolve(line.content);
                this.currentCommand = null;
            }
            
            // Process next queued command
            this.processQueue();
        }
        
        // Handle errors
        else if (line.dir === 'down' && line.content.startsWith('>err')) {
            if (this.currentCommand) {
                this.currentCommand.reject(new Error(line.content));
                this.currentCommand = null;
            }
            this.deviceReady = true;
            this.processQueue();
        }
    }
    
    /**
     * Parse machine status from "I ready X... Y... Z..." lines
     * @param line - Status line content
     * @returns Status object or null if not parseable
     */
    private parseStatus(line: string): SpoolerStatus | null {
        const match = line.match(/I ready X([\d.-]+) Y([\d.-]+) Z([\d.-]+)/);
        if (match) {
            return {
                x: parseFloat(match[1]),
                y: parseFloat(match[2]),
                z: parseFloat(match[3]),
                state: 'idle'
            };
        }
        
        // Handle other status formats if needed
        if (line.startsWith('I ')) {
            return {
                state: 'idle'
            };
        }
        
        return null;
    }
    
    /**
     * Send a single command to the device
     * @param command - Command string to send
     * @returns Promise that resolves with device response
     */
    async sendCommand(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            this.commandQueue.push({ command, resolve, reject });
            if (this.deviceReady && !this.currentCommand) {
                this.processQueue();
            }
        });
    }
    
    /**
     * Send multiple commands in sequence
     * @param commands - Array of command strings
     * @returns Promise that resolves with array of responses
     */
    async sendCommands(commands: string[]): Promise<string[]> {
        const results = [];
        for (const cmd of commands) {
            results.push(await this.sendCommand(cmd));
        }
        return results;
    }
    
    /**
     * Process the command queue
     */
    private async processQueue(): Promise<void> {
        if (this.commandQueue.length === 0 || !this.deviceReady || this.currentCommand) {
            return;
        }
        
        this.currentCommand = this.commandQueue.shift();
        this.deviceReady = false;
        this.setStatus('busy');
        
        try {
            const response = await fetch(`${this.host}/write-line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: this.currentCommand.command })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            // Track command timing for timeout detection
            const responseData: { time: string } = await response.json();
            this.lastCommandTime = new Date(responseData.time).getTime();
            
        } catch (error) {
            this.currentCommand.reject(error);
            this.currentCommand = null;
            this.deviceReady = true;
            this.setStatus('api-offline');
        }
    }
    
    /**
     * Send cancel command (bypasses queue)
     */
    async sendCancel(): Promise<void> {
        // Clear queue
        while (this.commandQueue.length > 0) {
            const cmd = this.commandQueue.shift();
            cmd.reject(new Error('Cancelled'));
        }
        
        // Cancel current command
        if (this.currentCommand) {
            this.currentCommand.reject(new Error('Cancelled'));
            this.currentCommand = null;
        }
        
        // Send cancel command directly
        try {
            await fetch(`${this.host}/write-line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: '!' })
            });
        } catch (error) {
            if (this.onError) {
                this.onError(error);
            }
        }
    }
    
    /**
     * Check if commands are currently being executed
     * @returns True if commands are being executed
     */
    isExecuting(): boolean {
        return this.currentCommand !== null || this.commandQueue.length > 0;
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
        if (this.status === 'idle' || this.status === 'unknown' || this.status === 'board-offline') {
            try {
                // Send ping command
                await this.sendCommand('ping');
            } catch (error) {
                // Ping failed, will be handled by normal error handling
            }
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
