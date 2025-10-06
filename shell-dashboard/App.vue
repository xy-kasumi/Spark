<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div v-cloak>
    <!-- Fixed Header with Status -->
    <header class="fixed-header">
      <div class="header-content">
        <img :src="logoUrl" alt="Spark Logo" class="header-logo" />
        <div class="status-info">
          <span :title="'Detailed status: ' + clientStatus">{{ statusEmoji }} {{ uiStatus }}</span>
          {{ busyStatusText }}
        </div>
        <button class="header-cancel" @click="cancelAll">CANCEL ALL</button>
      </div>
    </header>

    <!-- Main Content -->
    <div class="main-content">
      <div class="column">
        <AddJob :client="client" :isIdle="isIdle" />
        <JobList :client="client" />
        <CoordinateSystem :client="client" :isIdle="isIdle" />
        <Jog :client="client" :isIdle="isIdle" :getPStateAfter="getPStateAfter" />
        <ToolSupply :client="client" :isIdle="isIdle" />
        <Scan :client="client" :isIdle="isIdle" :getPStateAfter="getPStateAfter" :waitUntilIdle="waitUntilIdle" />
      </div>

      <div class="column">
        <Settings :client="client" :isIdle="isIdle" :getPStateAfter="getPStateAfter" />
        <Stats :client="client" :isIdle="isIdle" :getPStateAfter="getPStateAfter" />
        <Timeseries :client="client" />
        <Errors :client="client" />
        <ManualCommand :client="client" :isIdle="isIdle" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { SpoolerClient, sleep } from "./spooler";
import logoUrl from "./logo.png";
import AddJob from "./components/AddJob.vue";
import ManualCommand from "./components/ManualCommand.vue";
import CoordinateSystem from "./components/CoordinateSystem.vue";
import Jog from "./components/Jog.vue";
import ToolSupply from "./components/ToolSupply.vue";
import Scan from "./components/Scan.vue";
import JobList from "./components/JobList.vue";
import Settings from "./components/Settings.vue";
import Stats from "./components/Stats.vue";
import Timeseries from "./components/Timeseries.vue";
import Errors from "./components/Errors.vue";

const host = "http://localhost:9000";
const client = new SpoolerClient(host);
const clientStatus = ref<string>("unknown");
const busyStatusText = ref("");
const isPolling = ref(false);

const uiStatus = computed(() => {
  switch (clientStatus.value) {
    case "idle":
      return "idle";
    case "busy":
      return "busy";
    case "api-offline":
    case "board-offline":
    case "unknown":
      return "offline";
    default:
      return "offline";
  }
});

const statusEmoji = computed(() => {
  switch (uiStatus.value) {
    case "idle":
      return "🔵";
    case "busy":
      return "🟠";
    case "offline":
      return "⚫";
    default:
      return "⚫";
  }
});

const isIdle = computed(() => {
  return clientStatus.value === "idle";
});

async function waitUntilIdle(): Promise<void> {
  if (clientStatus.value === "idle") return;

  return new Promise((resolve) => {
    const unwatch = watch(clientStatus, (newStatus) => {
      if (newStatus === "idle") {
        unwatch();
        resolve();
      }
    });
  });
}

async function getPStateAfter(tag: string, time: Date): Promise<Record<string, any>> {
  while (true) {
    await waitUntilIdle();
    const res = await client.getLatestPState(tag);
    if (res === null) {
      continue;
    }
    if (res.time > time) {
      return res.pstate;
    }
  }
}

onMounted(() => {
  isPolling.value = true;
  pollStatus();
});

onBeforeUnmount(() => {
  isPolling.value = false;
});

async function pollStatus() {
  while (isPolling.value) {
    try {
      const status = await client.getStatus();
      const state = status.busy ? "busy" : "idle";
      clientStatus.value = state;
      if (state === "busy") {
        if (status.running_job) {
          busyStatusText.value = `Job ${status.running_job} running`;
        } else {
          busyStatusText.value = `${status.num_pending_commands} commands in queue`;
        }
      } else {
        busyStatusText.value = "";
      }
    } catch (error) {
      clientStatus.value = "api-offline";
      busyStatusText.value = "";
    }
    await sleep(100);
  }
}

function cancelAll() {
  client.cancel();
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

.fixed-header .header-cancel {
  margin-left: auto;
  margin-bottom: 0;
  background: #b52828;
  border-color: #8b1f1f;
  color: #ffffff;
}

.fixed-header .header-cancel:hover {
  background: #c83232;
}

/* Hide Vue templates until Vue loads */
[v-cloak] {
  display: none !important;
}
</style>