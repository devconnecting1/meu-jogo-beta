const fs = require("fs");
const p = "src/shared/data/usables.ts";
let s = fs.readFileSync(p, "utf8");
s = s.replace(
	/\{ id: (\d+), name: "([^"]+)", hp: (\d+), hunger: (\d+),/g,
	(_m, id, name, hp, hunger) =>
		`{ id: ${id}, name: "${name}", hp: ${hunger}, hunger: ${hp},`,
);
fs.writeFileSync(p, s);
console.log("swapped hp/hunger in usables");
