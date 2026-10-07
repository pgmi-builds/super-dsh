// Entry point for `node --import`; registers the sibling isolation hook.
import { register } from "node:module";

register("./fs-isolation-hook.mjs", import.meta.url);
