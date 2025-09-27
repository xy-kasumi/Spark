<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div v-cloak>
    <!-- Fixed Header with Status -->
    <header class="fixed-header">
      <div class="header-content">
        <img :src="logoUrl" alt="Spark Logo" class="header-logo">
        <div class="status-info">
          <span :title="'Detailed status: ' + clientStatus">{{ statusEmoji }} {{ uiStatus }}</span>
          {{ busyStatusText }}
        </div>
      </div>
    </header>

    <!-- Main Content -->
    <div class="main-content">
      <div class="column">
        <ManualCommand
          :client="client"
          :clientStatus="clientStatus"
          :assumeInitialized="assumeInitialized"
        />
        <CoordinateSystem :client="client" />
        <Jog :client="client" :latestPos="latestPos" />
        <ToolSupply :client="client" />
        <JobList />
      </div>

      <div class="column">
        <Settings :client="client" />
        <Timeseries />
      </div>
    </div>
  </div>
</template>

<script>
import { SpoolerController } from './spooler.ts';
import logoUrl from './logo.png';
import ManualCommand from './components/ManualCommand.vue';
import CoordinateSystem from './components/CoordinateSystem.vue';
import Jog from './components/Jog.vue';
import ToolSupply from './components/ToolSupply.vue';
import JobList from './components/JobList.vue';
import Settings from './components/Settings.vue';
import Timeseries from './components/Timeseries.vue';

// Global client instance for performance
let client = null;

export default {
    components: {
        ManualCommand,
        CoordinateSystem,
        Jog,
        ToolSupply,
        JobList,
        Settings,
        Timeseries,
    },
    data() {
        return {
            logoUrl,
            client: null,
            clientStatus: 'unknown',
            latestPos: {},
            busyStatusText: '',
        }
    },

    computed: {
        uiStatus() {
            switch (this.clientStatus) {
                case 'idle':
                    return 'idle';
                case 'busy':
                    return 'busy';
                case 'api-offline':
                case 'board-offline':
                case 'unknown':
                    return 'offline';
                default:
                    return 'offline';
            }
        },

        statusEmoji() {
            switch (this.uiStatus) {
                case 'idle': return '🔵';
                case 'busy': return '🟠';
                case 'offline': return '⚫';
                default: return '⚫';
            }
        },

        assumeInitialized() {
            return this.clientStatus === 'idle' || this.clientStatus === 'busy';
        },
    },

    mounted() {
        const host = "http://localhost:9000";
        client = new SpoolerController(host);
        this.client = client;

        client.onUpdatePos = (pos) => {
            this.latestPos = pos;
        };
        client.onUpdateStatus = (state, numCommands, runningJob) => {
            this.clientStatus = state;
            if (state === 'busy') {
                if (runningJob !== null) {
                    this.busyStatusText = `Job ${runningJob} running`;
                } else {
                    this.busyStatusText = `${numCommands} commands in queue`;
                }
            }
        };

        client.startPolling();
    },

    beforeUnmount() {
        if (client) {
            client.stopPolling();
        }
    },
}
</script>

<style>
/* Design tokens */
:root {
  --unit-space: 8px;
  --text-size: 16px;
  --radius: 4px;
  --accent: #00aeef;

  --bg-primary: #1a1a1a;
  --bg-secondary: #2d2d2d;
  --bg-widget: #252525;
  --text-primary: #e0e0e0;
  --text-secondary: #b0b0b0;
  --border-color: #404040;
  --shadow-color: rgba(0, 0, 0, 0.3);
  --button-bg: #404040;
  --button-hover: #4a4a4a;
}

/* Global page layout (header & columns) & widgets */
body {
  background-color: var(--bg-primary);
  color: var(--text-primary);
  font-family: Arial, sans-serif;
  font-size: var(--text-size);
  margin: 0;
}

.fixed-header {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-color);
  padding: 10px 20px;
  z-index: 1000;
  box-shadow: 0 2px 4px var(--shadow-color);
}

.header-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 20px;
}

.main-content {
  display: flex;
  gap: calc(var(--unit-space) * 2);
  /* two widget width + gap */
  width: calc(var(--unit-space) * (70 * 2 + 2));

  margin: 0 auto;

  /* overlap with header */
  padding-top: 88px;
}

.column {
  width: calc(var(--unit-space) * 70);
}

.widget {
  width: calc(var(--unit-space) * 70);
  background: var(--bg-widget);
  border: 1px solid var(--border-color);
  box-shadow: 0 2px 4px var(--shadow-color);
  margin-bottom: calc(var(--unit-space) * 2);
}

.widget>h1 {
  font-size: var(--text-size);
  font-weight: bold;
  margin: 0;
  border-bottom: 1px solid var(--accent);
  color: var(--text-primary);
  padding: var(--unit-space);
  background: var(--bg-secondary);
}

.widget>.widget-content {
  padding: var(--unit-space);
}

/* Components */
button {
  background: var(--button-bg);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  padding: var(--unit-space);
  height: calc(var(--unit-space) * 4);

  font-size: calc(var(--text-size) * 0.8);
  /* since button texts are all-caps, make it smaller to balance with bold titles */
  font-weight: bold;
  line-height: 1;

  border-radius: var(--radius);
  cursor: pointer;

  margin-right: var(--unit-space);
  margin-bottom: var(--unit-space);
}

button:hover {
  background: var(--button-hover);
}

button:disabled {
  background: #2a2a2a;
  color: #666;
  cursor: not-allowed;
}

textarea,
input[type="text"],
input[type="number"],
input[type="checkbox"] {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
  padding: var(--unit-space);
  border-radius: var(--radius);
  margin-bottom: var(--unit-space);
}

textarea {
  line-height: 1.4;
}

textarea:focus,
input:focus {
  border-color: #555;
  outline: none;
}

label {
  color: var(--text-primary);
  margin-right: 15px;
}


/* Part-specific things */
.fixed-header .header-logo {
  height: 40px;
  width: auto;
}

.fixed-header .status-info {
  display: flex;
  align-items: center;
  gap: 15px;
  font-size: 16px;
}

/* Hide Vue templates until Vue loads */
[v-cloak] {
  display: none !important;
}
</style>