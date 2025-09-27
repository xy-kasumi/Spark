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

<script>
import { markRaw } from "vue";
import { Chart, registerables } from "chart.js";
import { spoolerApi } from "../spooler.ts";

Chart.register(...registerables);

const toLocalDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

function toLocalTime(d = new Date()) {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms[0]}`;
}

export default {
  name: "Timeseries",
  data() {
    return {
      span: 60,
      refreshInterval: 0,
      chart: null,
      refreshTimer: null,
    };
  },
  mounted() {
    this.chart = markRaw(
      new Chart(this.$refs.chartCanvas, {
        type: "line",
        data: { datasets: [] },
        options: { animation: false },
      })
    );
  },
  beforeUnmount() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }
    if (this.chart) {
      this.chart.destroy();
    }
  },
  watch: {
    span() {
      this.refreshNow();
    },
    refreshInterval(newVal) {
      this.setupAutoRefresh(newVal);
    },
  },
  methods: {
    setupAutoRefresh(intervalSeconds) {
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
      }

      if (intervalSeconds > 0) {
        this.refreshTimer = setInterval(() => {
          this.refreshNow();
        }, intervalSeconds * 1000);
      }
    },
    async refreshNow() {
      let visibleKeys = this.chart
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
      const start = new Date((nowSec - this.span) * 1e3);
      const end = new Date(nowSec * 1e3);

      const targetNumSteps = 100;
      const preAdjustStep = this.span / targetNumSteps;
      let step;

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
      const dateToLabel = (d) => {
        return (includeDate ? toLocalDate(d) + " " : "") + toLocalTime(d);
      };

      const host = "http://localhost:9000";
      const res = await spoolerApi.queryTS(host, start, end, step, keys);
      this.chart.data.labels = res.times.map(dateToLabel);
      this.chart.data.datasets = keys.map((key) => ({
        label: key,
        data: res.values[key],
        hidden: !visibleKeys.includes(key),
      }));
      console.log(this.chart.data.datasets);
      this.chart.update();
    },
  },
};
</script>