<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Timeseries</h1>
    <div class="widget-content">
      <div>
        <label class="">
          <input type="radio" name="mode" value="latest" v-model="mode" />
          Latest
        </label>
        <label class="">
          <input type="radio" name="mode" value="since" v-model="mode" />
          Since
        </label>
        <div v-if="mode === 'since'">
          <input type="text" v-model="sinceText" @blur="refreshNow" placeholder="2025-12-20 12:21:02" />
        </div>
      </div>

      <div>
        Window
        <label class="">
          <input type="radio" name="span" :value="60" v-model.number="span" />
          1m
        </label>
        <label class="">
          <input type="radio" name="span" :value="600" v-model.number="span" />
          10m
        </label>
        <label class="">
          <input type="radio" name="span" :value="3600" v-model.number="span" />
          60m
        </label>
      </div>

      <div>
        Auto refresh
        <label class="">
          <input type="radio" name="refreshInterval" :value="0" v-model.number="refreshInterval" />
          No
        </label>
        <label class="">
          <input type="radio" name="refreshInterval" :value="10" v-model.number="refreshInterval" />
          10s
        </label>
        <label class="">
          <input type="radio" name="refreshInterval" :value="60" v-model.number="refreshInterval" />
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
import { SpoolerClient } from "../spooler";

Chart.register(...registerables);

const props = defineProps<{
  client: SpoolerClient;
}>();

function toLocalDate(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function toLocalTime(d: Date, showMsec = true) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  if (showMsec) {
    const ms = String(d.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms[0]}`;
  } else {
    return `${h}:${m}:${s}`;
  }
}

function toLocalDateTime(d: Date): string {
  return `${toLocalDate(d)} ${toLocalTime(d, false)}`;
}

// Parses local datetime string. Both date and time are mandatory.
// Format: "YYYY-MM-DD HH:MM:SS" (e.g., "2025-12-20 12:21:02")
// Falls back to (now - 60s) if parsing fails.
function parseLocalDateTime(text: string): Date {
  const parts = text.match(/(\d+)-(\d+)-(\d+)\s+(\d+):(\d+):(\d+)/);
  if (!parts) {
    const nowSec = Math.floor(new Date().getTime() * 1e-3);
    return new Date((nowSec - 60) * 1e3);
  }
  const [, y, m, d, h, min, s] = parts;
  return new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min), Number(s));
}

const mode = ref<"latest" | "since">("latest");
const span = ref(60);
const sinceText = ref("");
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
  refreshNow();
});

onBeforeUnmount(() => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }
  if (chart.value) {
    chart.value.destroy();
  }
});

watch(mode, (newMode) => {
  if (newMode === "since") {
    const nowSec = Math.floor(new Date().getTime() * 1e-3);
    const start = new Date((nowSec - span.value) * 1e3);
    sinceText.value = toLocalDateTime(start);
    refreshNow();
  } else {
    refreshNow();
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

  let start: Date;
  let end: Date;

  if (mode.value === "latest") {
    const nowSec = Math.floor(new Date().getTime() * 1e-3);
    start = new Date((nowSec - span.value) * 1e3);
    end = new Date(nowSec * 1e3);
  } else {
    start = parseLocalDateTime(sinceText.value);
    end = new Date(start.getTime() + span.value * 1e3);
  }

  const spanSec = (end.getTime() - start.getTime()) / 1000;
  const targetNumSteps = 100;
  const preAdjustStep = spanSec / targetNumSteps;
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

  const res = await props.client.queryTS(start, end, step, keys);
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