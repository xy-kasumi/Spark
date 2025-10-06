<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Scan</h1>
    <div class="widget-content">
      <button @click="prepare" :disabled="!isIdle">PREPARE</button>
      <button @click="scan" :disabled="!isIdle">SCAN</button>
      <button @click="reset">RESET</button>
      <br />
      <div>N={{ count }} (avg={{ average }}, min={{ min }}, max={{ max }})</div>
      <div>Data: {{ measurementsText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
  isIdle: boolean;
  getPStateAfter: (tag: string, time: Date) => Promise<Record<string, any>>;
  waitUntilIdle: (after: Date) => Promise<void>;
}>();

const measurements = ref<number[]>([]);

const measurementsText = computed(() => {
  return measurements.value.map(v => v.toFixed(3)).join(", ");
});

const count = computed(() => {
  return measurements.value.length;
});

const average = computed(() => {
  if (measurements.value.length === 0) return "N/A";
  const sum = measurements.value.reduce((acc, val) => acc + val, 0);
  return (sum / measurements.value.length).toFixed(3);
});

const min = computed(() => {
  if (measurements.value.length === 0) return "N/A";
  return Math.min(...measurements.value).toFixed(3);
});

const max = computed(() => {
  if (measurements.value.length === 0) return "N/A";
  return Math.max(...measurements.value).toFixed(3);
});

async function prepare() {
  props.client.enqueueCommands([
    "G55", // work coords
    "G0 Y-8 X-15 Z60", // safe pos to the right of the work
    "G0 Z35", // insert tool
  ]);
}

async function scan() {
  const measurementTime = await props.client.enqueueCommands([
    "M3 P100 Q0.1 R5",
    "G38.3 Y0"
  ]);
  await props.waitUntilIdle(measurementTime);

  const posQueryTime = await props.client.enqueueCommand("?pos");
  const pstate = await props.getPStateAfter("pos", posQueryTime);
  measurements.value.push(pstate["m.y"]);

  props.client.enqueueCommand("G0 Y-8"); // evacuate
}

function reset() {
  measurements.value = [];
}
</script>
