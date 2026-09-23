// scratch (deleted before commit): replace worldView.drawBuildingArt with the compound-footprint version
import { readFileSync, writeFileSync } from "node:fs";

const file = "src/client/view/worldView.ts";
const src = readFileSync(file, "utf8");
const start = src.indexOf("\t/**\n\t * A building with textured roof, floor and soft shadow.");
const end = src.indexOf("\t/** an air conditioner and a vent on a flat roof");
if (start < 0 || end < 0) throw new Error("markers not found");
const repl = readFileSync(process.argv[2], "utf8");
writeFileSync(file, src.slice(0, start) + repl + src.slice(end));
console.log("spliced", end - start, "chars");
