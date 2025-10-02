<!-- SPDX-FileCopyrightText: 2025 夕月霞 -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<template>
  <div class="widget">
    <h1>Add Job</h1>
    <div class="widget-content">
      <button class="" @click="pasteFromClipboard">PASTE FROM CLIPBOARD</button>
      <span v-if="commands.length > 0">{{ linesInfo }}</span
      ><br />
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
    linesInfo() {
      const count = this.commands.length;
      if (count === 0) return "";
      const firstCmd = this.commands[0];
      const preview = firstCmd.length > 20 ? firstCmd.slice(0, 20) : firstCmd;
      return `${count} lines (${preview}...)`;
    },
    executeButtonText() {
      return this.clientStatus === "idle" ? "EXECUTE" : "ENQUEUE";
    },
  },
  methods: {
    async pasteFromClipboard() {
      try {
        const text = await navigator.clipboard.readText();
        this.commandText = text;
      } catch (err) {
        console.error("Failed to read clipboard:", err);
      }
    },

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
