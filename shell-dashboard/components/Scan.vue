<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Scan</h1>
    <div class="widget-content">
      <button @click="prepare">PREPARE</button>
      <button @click="scan">SCAN</button>
      <button @click="reset">RESET</button>
      <br />
      <div>N={{ count }} (avg={{ average }}, min={{ min }}, max={{ max }})</div>
      <div>Data: {{ measurementsText }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { sleep, SpoolerClient } from "../spooler";

const props = defineProps<{
  client: SpoolerClient;
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
  // Exec measurement
  props.client.enqueueCommands([
    "M3 P100 Q0.1 R5",
    "G38.3 Y0"
  ]);
  await sleep(5000);
  props.client.enqueueCommand("?pos");
  await sleep(100);
  const pos = await props.client.getLatestPState("pos");
  props.client.enqueueCommand("G0 Y-8"); // evacuate
  await sleep(1000);
  if (pos === null) {
    console.error("pos query failed");
    return;
  }
  measurements.value.push(pos.pstate["m.y"]);
}

function reset() {
  measurements.value = [];
}
</script>
