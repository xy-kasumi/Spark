<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget" id="widget-joblist">
    <h1>Job List</h1>
    <div class="widget-content">
      <button @click="refreshJobs">REFRESH</button>
      <div v-if="jobs.length === 0">No jobs found</div>
      <table
        v-else
        style="
          width: 100%;
          border-collapse: collapse;
          margin-top: var(--unit-space);
        "
      >
        <thead>
          <tr>
            <th
              style="
                text-align: left;
                padding: calc(var(--unit-space) * 0.5);
                border-bottom: 1px solid var(--border-color);
              "
            >
              Status
            </th>
            <th
              style="
                text-align: left;
                padding: calc(var(--unit-space) * 0.5);
                border-bottom: 1px solid var(--border-color);
              "
            >
              Started
            </th>
            <th
              style="
                text-align: left;
                padding: calc(var(--unit-space) * 0.5);
                border-bottom: 1px solid var(--border-color);
              "
            >
              Elapsed
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="job in jobs" :key="job.job_id">
            <td
              style="
                padding: calc(var(--unit-space) * 0.5);
                border-bottom: 1px solid var(--border-color);
              "
            >
              {{ job.status }}
            </td>
            <td
              style="
                padding: calc(var(--unit-space) * 0.5);
                border-bottom: 1px solid var(--border-color);
              "
            >
              {{ formatJobTime(job.time_added) }}
            </td>
            <td
              style="
                padding: calc(var(--unit-space) * 0.5);
                border-bottom: 1px solid var(--border-color);
              "
            >
              {{ getElapsedTime(job) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script>
import { spoolerApi } from "../spooler.ts";

export default {
  name: "JobList",
  data() {
    return {
      jobs: [],
    };
  },
  methods: {
    async refreshJobs() {
      try {
        const host = "http://localhost:9000";
        this.jobs = await spoolerApi.listJobs(host);
      } catch (error) {
        console.error("Failed to refresh jobs:", error);
        this.jobs = [];
      }
    },

    formatJobTime(date) {
      return date.toLocaleString();
    },

    getElapsedTime(job) {
      const now = new Date();
      let startTime;
      let endTime;

      if (job.time_started) {
        startTime = job.time_started;
      } else {
        startTime = job.time_added;
      }

      if (job.time_ended) {
        endTime = job.time_ended;
      } else {
        endTime = now;
      }

      const elapsedMs = endTime.getTime() - startTime.getTime();
      const elapsedSec = Math.floor(elapsedMs / 1000);

      const hours = Math.floor(elapsedSec / 3600);
      const minutes = Math.floor((elapsedSec % 3600) / 60);
      const seconds = elapsedSec % 60;

      if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
      } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
      } else {
        return `${seconds}s`;
      }
    },
  },
};
</script>