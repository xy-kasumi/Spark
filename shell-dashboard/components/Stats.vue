<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Stats</h1>
    <div class="widget-content">
      <button @click="dumpStats" :disabled="!isIdle">DUMP STATS</button>
      <br />
      <div v-if="lastFetchTime" class="last-fetch">
        Last fetch: {{ lastFetchTime }}
      </div>
      <div v-if="Object.keys(stats).length === 0" class="stats-placeholder">
        Click DUMP STATS to load statistics
      </div>
      <div v-else>
        <label>Filter
          <input type="text" v-model="statsFilter" placeholder="Enter filter..." /></label>
        <div class="stats-info">
          Showing {{ statsCount.filtered }}/{{ statsCount.total }} items
        </div>
        <div class="stats-table-container">
          <table class="stats-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(value, key) in filteredStats" :key="key">
                <td>
                  <template v-if="keyParts(key).match">
                    {{ keyParts(key).before }}<span class="highlight">{{ keyParts(key).match }}</span>{{
                    keyParts(key).after }}
                  </template>
                  <template v-else>{{ key }}</template>
                </td>
                <td>{{ value }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { sleep, SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
  isIdle: boolean;
}>();

const stats = ref<Record<string, any>>({});
const statsFilter = ref("");
const lastFetchTime = ref<string>("");

const filteredStats = computed(() => {
  if (!statsFilter.value.trim()) {
    return stats.value;
  }

  const filter = statsFilter.value.toLowerCase();
  const filtered: Record<string, any> = {};

  for (const [key, value] of Object.entries(stats.value)) {
    if (key.toLowerCase().includes(filter)) {
      filtered[key] = value;
    }
  }

  return filtered;
});

const statsCount = computed(() => {
  const total = Object.keys(stats.value).length;
  const filtered = Object.keys(filteredStats.value).length;
  return { filtered, total };
});

async function dumpStats() {
  props.client.enqueueCommand("stat");

  await sleep(5000);

  const res = await props.client.getLatestPState("stat");
  if (res === null) {
    console.error("stat command didn't result in stats within 5000ms");
    return;
  }

  stats.value = res.pstate;
  lastFetchTime.value = new Date(res.time * 1000).toLocaleString();
  console.log("Stats retrieved:", stats.value);
}

function keyParts(key: string) {
  if (!statsFilter.value.trim()) {
    return { before: "", match: "", after: "" };
  }

  const filter = statsFilter.value.toLowerCase();
  const keyLower = key.toLowerCase();
  const index = keyLower.indexOf(filter);

  if (index === -1) {
    return { before: "", match: "", after: "" };
  }

  const before = key.substring(0, index);
  const match = key.substring(index, index + filter.length);
  const after = key.substring(index + filter.length);

  return { before, match, after };
}
</script>

<style scoped>
.last-fetch {
  color: var(--text-secondary);
  font-size: calc(var(--text-size) * 0.9);
  margin-bottom: calc(var(--unit-space) * 0.5);
}

.stats-placeholder {
  color: var(--text-secondary);
  font-style: italic;
  margin-top: var(--unit-space);
}

.stats-table-container {
  max-height: 300px;
  overflow-y: auto;
  margin-top: var(--unit-space);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.stats-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-secondary);
}

.stats-table th,
.stats-table td {
  padding: calc(var(--unit-space) * 0.75);
  text-align: left;
  border-bottom: 1px solid var(--border-color);
}

.stats-table th {
  background: var(--bg-widget);
  color: var(--text-primary);
  font-weight: bold;
  position: sticky;
  top: 0;
  z-index: 1;
}

.stats-table td {
  color: var(--text-primary);
}

.stats-table tbody tr:hover {
  background: var(--button-bg);
}

.stats-info {
  color: var(--text-secondary);
  font-size: calc(var(--text-size) * 0.9);
  margin-bottom: calc(var(--unit-space) * 0.5);
}

.highlight {
  background-color: var(--accent);
  color: white;
  padding: 1px 2px;
  border-radius: 2px;
  font-weight: bold;
}
</style>
