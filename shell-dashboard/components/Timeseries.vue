<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Timeseries</h1>
    <div class="widget-content">
      <div>
        Last
        <label class="">
          <input
            type="radio"
            name="span"
            :value="60"
            v-model.number="span"
          />
          1m
        </label>
        <label class="">
          <input
            type="radio"
            name="span"
            :value="600"
            v-model.number="span"
          />
          10m
        </label>
        <label class="">
          <input
            type="radio"
            name="span"
            :value="3600"
            v-model.number="span"
          />
          60m
        </label>
      </div>
      <div>
        Auto refresh
        <label class="">
          <input
            type="radio"
            name="refreshInterval"
            :value="0"
            v-model.number="refreshInterval"
          />
          No
        </label>
        <label class="">
          <input
            type="radio"
            name="refreshInterval"
            :value="10"
            v-model.number="refreshInterval"
          />
          10s
        </label>
        <label class="">
          <input
            type="radio"
            name="refreshInterval"
            :value="60"
            v-model.number="refreshInterval"
          />
          1m
        </label>
        <button @click="refreshNow">REFRESH</button>
      </div>
      <canvas ref="chartCanvas" width="500" height="300"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, watch, onMounted, onBeforeUnmount } from "vue";
import { Chart, registerables } from "chart.js";
import { spoolerApi } from "../spooler";

Chart.register(...registerables);

function toLocalDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toLocalTime(d: Date) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms[0]}`;
}

const span = ref(60);
const refreshInterval = ref(0);
const chartCanvas = ref<HTMLCanvasElement>();
const chart = shallowRef<Chart | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  chart.value = new Chart(chartCanvas.value!, {
    type: "line",
    data: { datasets: [] },
    options: { animation: false },
  });
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  if (chart.value) {
    chart.value.destroy();
  }
});

watch(span, () => {
  refreshNow();
});

watch(refreshInterval, (newVal) => {
  setupAutoRefresh(newVal);
});

function setupAutoRefresh(intervalSeconds: number) {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  if (intervalSeconds > 0) {
    refreshTimer = setInterval(() => {
      refreshNow();
    }, intervalSeconds * 1000);
  }
}

async function refreshNow() {
  let visibleKeys = chart.value!
    .getSortedVisibleDatasetMetas()
    .map((meta) => meta.label);
  const keys = [
    "queue.num",
    "edm.open",
    "edm.short",
    "edm.pb_f",
    "edm.pb_b",
    "edm.dist",
    "edm.dist_max",
  ];
  if (visibleKeys.length === 0) {
    visibleKeys = keys;
  }
  console.log("visible keys", visibleKeys);

  const nowSec = Math.floor(new Date().getTime() * 1e-3);
  const start = new Date((nowSec - span.value) * 1e3);
  const end = new Date(nowSec * 1e3);

  const targetNumSteps = 100;
  const preAdjustStep = span.value / targetNumSteps;
  let step: number;

  if (preAdjustStep < 0.5) {
    step = 0.5;
  } else if (preAdjustStep < 1) {
    step = 1;
  } else if (preAdjustStep < 5) {
    step = 5;
  } else if (preAdjustStep < 10) {
    step = 10;
  } else if (preAdjustStep < 30) {
    step = 30;
  } else if (preAdjustStep < 60) {
    step = 60;
  } else {
    step = Math.ceil(preAdjustStep / 60) * 60;
  }

  const includeDate =
    toLocalDate(start) != toLocalDate(new Date()) ||
    toLocalDate(end) != toLocalDate(new Date());
  const dateToLabel = (d: Date) => {
    return (includeDate ? toLocalDate(d) + " " : "") + toLocalTime(d);
  };

  const host = "http://localhost:9000";
  const res = await spoolerApi.queryTS(host, start, end, step, keys);
  chart.value!.data.labels = res.times.map(dateToLabel);
  chart.value!.data.datasets = keys.map((key) => ({
    label: key,
    data: res.values[key],
    hidden: !visibleKeys.includes(key),
  }));
  console.log(chart.value!.data.datasets);
  chart.value!.update();
}
</script>