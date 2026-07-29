import { defineStepPack } from "@lwmacct/260729-ba-framework/pack";
import request from "./steps/request.js";

export default defineStepPack({
  id: "http/core",
  steps: [request],
});
