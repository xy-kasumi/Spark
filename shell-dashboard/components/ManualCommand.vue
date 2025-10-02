<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Manual Command</h1>
    <div class="widget-content">
      <button class="" @click="init">{{ initButtonText }}</button>
      <br />
      <textarea
        class=""
        v-model="commandText"
        rows="10"
        cols="50"
        placeholder="Enter G-code or commands"
      ></textarea
      ><br />
      <button
        class=""
        @click="send"
        :disabled="commands.length === 0 || !assumeInitialized"
      >
        {{ executeButtonText }}
      </button>
      <label class="">
        <input type="checkbox" v-model="clearOnExec" /> Clear on exec
      </label>
      <label class=""> <input type="checkbox" v-model="asJob" /> As Job </label>
    </div>
  </div>
</template>

<script>
import { spoolerApi } from "../spooler.ts";

export default {
  name: "ManualCommand",
  props: {
    client: Object,
    clientStatus: String,
    assumeInitialized: Boolean,
  },
  emits: ["command-sent"],
  data() {
    return {
      commandText: "",
      clearOnExec: true,
      asJob: false,
    };
  },
  computed: {
    commands() {
      return this.commandText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
    initButtonText() {
      return this.clientStatus === "idle" ? "INIT" : "ENQUEUE INIT";
    },
    executeButtonText() {
      return this.clientStatus === "idle" ? "EXECUTE" : "ENQUEUE";
    },
  },
  methods: {
    async init() {
      if (!this.client) {
        return;
      }

      const host = "http://localhost:9000";
      const initData = await spoolerApi.getInit(host);
      for (const cmd of initData.lines) {
        this.client.enqueueCommand(cmd);
      }
    },

    send() {
      if (!this.client || this.commands.length === 0) {
        return;
      }

      const host = "http://localhost:9000";
      if (this.asJob) {
        spoolerApi.addJob(host, this.commands, {
          "?pos": 1,
          "?edm": 0.5,
        });
      } else {
        this.client.enqueueCommands(this.commands);
      }

      if (this.clearOnExec) {
        this.commandText = "";
      }

      this.$emit("command-sent");
    },
  },
};
</script>