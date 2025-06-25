// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SpoolerClient handles all communication with shell-spooler using the new line-based API.
 * It manages command queuing, device readiness, and protocol parsing.
 */
class SpoolerClient {
    /**
     * @param {string} host base URL of the shell-spooler server
     */
    constructor(host) {
        this.host = host;
        this.commandQueue = [];
        this.currentCommand = null;
        this.deviceReady = true;
        this.lastLineNum = 0;
        this.isPolling = false;
        
        // Callbacks for UI updates
        this.onStatusUpdate = null;
        this.onLogLine = null;
        this.onError = null;
    }
    
    /**
     * Start polling for new lines from the spooler
     * @param {number} interval - Polling interval in milliseconds
     */
    startPolling(interval = 100) {
        this.isPolling = true;
        this._pollLoop(interval);
    }
    
    /**
     * Stop polling
     */
    stopPolling() {
        this.isPolling = false;
    }
    
    /**
     * Internal polling loop
     * @param {number} interval - Polling interval in milliseconds
     */
    async _pollLoop(interval) {
        while (this.isPolling) {
            await this._fetchNewLines();
            await this._delay(interval);
        }
    }
    
    /**
     * Fetch new lines from the spooler
     */
    async _fetchNewLines() {
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
            
            const { lines } = await response.json();
            for (const line of lines) {
                this._processLine(line);
                this.lastLineNum = line.line_num;
            }
        } catch (error) {
            if (this.onError) {
                this.onError(error);
            }
        }
    }
    
    /**
     * Process a single line from the spooler
     * @param {Object} line - Line object with line_num, dir, content, time
     */
    _processLine(line) {
        // Notify UI of new log line
        if (this.onLogLine) {
            this.onLogLine(line);
        }
        
        // Handle device responses (lines from device to host)
        if (line.dir === 'down' && line.content.startsWith('I')) {
            this.deviceReady = true;
            
            // Parse and notify status update
            const status = this._parseStatus(line.content);
            if (status && this.onStatusUpdate) {
                this.onStatusUpdate(status);
            }
            
            // Complete current command
            if (this.currentCommand) {
                this.currentCommand.resolve(line.content);
                this.currentCommand = null;
            }
            
            // Process next queued command
            this._processQueue();
        }
        
        // Handle errors
        else if (line.dir === 'down' && line.content.startsWith('>err')) {
            if (this.currentCommand) {
                this.currentCommand.reject(new Error(line.content));
                this.currentCommand = null;
            }
            this.deviceReady = true;
            this._processQueue();
        }
    }
    
    /**
     * Parse machine status from "I ready X... Y... Z..." lines
     * @param {string} line - Status line content
     * @returns {Object|null} Status object or null if not parseable
     */
    _parseStatus(line) {
        const match = line.match(/I ready X([\d.-]+) Y([\d.-]+) Z([\d.-]+)/);
        if (match) {
            return {
                x: parseFloat(match[1]),
                y: parseFloat(match[2]),
                z: parseFloat(match[3]),
                ready: true,
                status: 'OK'
            };
        }
        
        // Handle other status formats if needed
        if (line.startsWith('I ')) {
            return {
                ready: true,
                status: 'OK'
            };
        }
        
        return null;
    }
    
    /**
     * Send a single command to the device
     * @param {string} command - Command string to send
     * @returns {Promise<string>} Promise that resolves with device response
     */
    async sendCommand(command) {
        return new Promise((resolve, reject) => {
            this.commandQueue.push({ command, resolve, reject });
            if (this.deviceReady && !this.currentCommand) {
                this._processQueue();
            }
        });
    }
    
    /**
     * Send multiple commands in sequence
     * @param {string[]} commands - Array of command strings
     * @returns {Promise<string[]>} Promise that resolves with array of responses
     */
    async sendCommands(commands) {
        const results = [];
        for (const cmd of commands) {
            results.push(await this.sendCommand(cmd));
        }
        return results;
    }
    
    /**
     * Process the command queue
     */
    async _processQueue() {
        if (this.commandQueue.length === 0 || !this.deviceReady || this.currentCommand) {
            return;
        }
        
        this.currentCommand = this.commandQueue.shift();
        this.deviceReady = false;
        
        try {
            const response = await fetch(`${this.host}/write-line`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ line: this.currentCommand.command })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
        } catch (error) {
            this.currentCommand.reject(error);
            this.currentCommand = null;
            this.deviceReady = true;
        }
    }
    
    /**
     * Send cancel command (bypasses queue)
     */
    async sendCancel() {
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
     * @returns {boolean} True if commands are being executed
     */
    isExecuting() {
        return this.currentCommand !== null || this.commandQueue.length > 0;
    }
    
    /**
     * Utility function to delay execution
     * @param {number} ms - Milliseconds to delay
     * @returns {Promise} Promise that resolves after delay
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}