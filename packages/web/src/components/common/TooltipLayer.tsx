import { useEffect } from "react";
import { mountTooltipLayer } from "../../lib/tooltip-layer.js";

export function TooltipLayer() {
  useEffect(mountTooltipLayer, []);
  return null;
}
