import { writeFile } from "node:fs/promises";

const tubularSegments = 128;
const radialSegments = 64;
const majorRadius = 1;
const tubeRadius = 0.4;

function pointLine(prefix, point) {
  return `${prefix} ${point.x.toFixed(6)} ${point.y.toFixed(6)} ${point.z.toFixed(6)}`;
}

const lines = [
  "# Halo donut in its neutral model-space pose.",
  "mtllib halo-donut-3d.mtl",
  "o HaloDonut",
];

for (let tubeIndex = 0; tubeIndex <= tubularSegments; tubeIndex += 1) {
  const tubeAngle = (tubeIndex / tubularSegments) * Math.PI * 2;
  const cosTube = Math.cos(tubeAngle);
  const sinTube = Math.sin(tubeAngle);

  for (let radialIndex = 0; radialIndex <= radialSegments; radialIndex += 1) {
    const radialAngle = (radialIndex / radialSegments) * Math.PI * 2;
    const cosRadial = Math.cos(radialAngle);
    const sinRadial = Math.sin(radialAngle);
    const localPoint = {
      x: (majorRadius + tubeRadius * cosRadial) * cosTube,
      y: (majorRadius + tubeRadius * cosRadial) * sinTube,
      z: tubeRadius * sinRadial,
    };
    const localNormal = {
      x: cosRadial * cosTube,
      y: cosRadial * sinTube,
      z: sinRadial,
    };
    lines.push(pointLine("v", localPoint));
    lines.push(pointLine("vn", localNormal));
  }
}

lines.push("usemtl HaloPurple", "s 1");

const rowLength = radialSegments + 1;
for (let tubeIndex = 0; tubeIndex < tubularSegments; tubeIndex += 1) {
  for (let radialIndex = 0; radialIndex < radialSegments; radialIndex += 1) {
    const a = tubeIndex * rowLength + radialIndex + 1;
    const b = (tubeIndex + 1) * rowLength + radialIndex + 1;
    const c = (tubeIndex + 1) * rowLength + radialIndex + 2;
    const d = tubeIndex * rowLength + radialIndex + 2;
    lines.push(`f ${a}//${a} ${b}//${b} ${d}//${d}`);
    lines.push(`f ${b}//${b} ${c}//${c} ${d}//${d}`);
  }
}

const assetDirectory = new URL("../packages/web/src/assets/", import.meta.url);

await writeFile(
  new URL("halo-donut-3d.obj", assetDirectory),
  `${lines.join("\n")}\n`,
);
await writeFile(
  new URL("halo-donut-3d.mtl", assetDirectory),
  [
    "newmtl HaloPurple",
    "Kd 0.764706 0.470588 0.905882",
    "Ks 0.100000 0.100000 0.100000",
    "Ns 24.000000",
    "illum 2",
    "",
  ].join("\n"),
);
