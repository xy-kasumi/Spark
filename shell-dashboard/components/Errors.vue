<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Errors</h1>
    <div class="widget-content">
      <button @click="refreshErrors">REFRESH</button>
      <div v-if="errors.length === 0">No errors found</div>
      <div v-else style="
          max-height: 300px;
          overflow-y: auto;
          margin-top: var(--unit-space);
        ">
        <table style="
            width: 100%;
            border-collapse: collapse;
          ">
          <thead>
            <tr>
              <th style="
                  text-align: left;
                  padding: calc(var(--unit-space) * 0.5);
                  border-bottom: 1px solid var(--border-color);
                ">
                Timestamp
              </th>
              <th style="
                  text-align: left;
                  padding: calc(var(--unit-space) * 0.5);
                  border-bottom: 1px solid var(--border-color);
                ">
                Error
              </th>
              <th style="
                  text-align: left;
                  padding: calc(var(--unit-space) * 0.5);
                  border-bottom: 1px solid var(--border-color);
                ">
                Source
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(error, index) in errors" :key="index">
              <td style="
                  padding: calc(var(--unit-space) * 0.5);
                  border-bottom: 1px solid var(--border-color);
                  white-space: nowrap;
                ">
                {{ formatTimestamp(error.time) }}
              </td>
              <td style="
                  padding: calc(var(--unit-space) * 0.5);
                  border-bottom: 1px solid var(--border-color);
                ">
                {{ error.msg }}
              </td>
              <td style="
                  padding: calc(var(--unit-space) * 0.5);
                  border-bottom: 1px solid var(--border-color);
                  color: var(--text-secondary);
                  font-size: calc(var(--text-size) * 0.9);
                ">
                {{ error.src || '-' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { spoolerApi } from "../spooler";

const errors = ref<Array<{ time: Date; msg: string; src?: string }>>([]);
let intervalId: number | undefined;

async function refreshErrors() {
  try {
    const host = "http://localhost:9000";
    errors.value = await spoolerApi.getErrors(host);
  } catch (error) {
    console.error("Failed to refresh errors:", error);
    errors.value = [];
  }
}

function formatTimestamp(date: Date) {
  return date.toLocaleString();
}

onMounted(() => {
  refreshErrors();
  intervalId = window.setInterval(refreshErrors, 5000);
});

onUnmounted(() => {
  if (intervalId !== undefined) {
    clearInterval(intervalId);
  }
});
</script>
