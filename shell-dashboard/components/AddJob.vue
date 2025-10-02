<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Add Job</h1>
    <div class="widget-content">
      <textarea
        class=""
        v-model="commandText"
        rows="1"
        cols="50"
        placeholder="Paste G-code here"
      ></textarea>
      <div v-if="commands.length > 0">
        <span>{{ commands.length }} lines</span>
      </div>
      <br />
      <button
        class=""
        @click="send"
        :disabled="commands.length === 0 || !assumeInitialized"
      >
        {{ executeButtonText }}
      </button>
    </div>
  </div>
</template>

<script>
import { spoolerApi } from "../spooler.ts";

export default {
  name: "AddJob",
  props: {
    client: Object,
    clientStatus: String,
    assumeInitialized: Boolean,
  },
  emits: ["command-sent"],
  data() {
    return {
      commandText: "",
    };
  },
  computed: {
    commands() {
      return this.commandText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },
    executeButtonText() {
      return this.clientStatus === "idle" ? "EXECUTE" : "ENQUEUE";
    },
  },
  methods: {
    send() {
      if (!this.client || this.commands.length === 0) {
        return;
      }

      const host = "http://localhost:9000";
      spoolerApi.addJob(host, this.commands, {
        "?pos": 1,
        "?edm": 0.5,
      });

      this.commandText = "";

      this.$emit("command-sent");
    },
  },
};
</script>
