/** Triangle meshes as STL files, for measuring tests. A triangle is three [x, y, z] points. */
export type Point = [number, number, number];
export type Triangle = [Point, Point, Point];

/** An axis-aligned cube with outward-facing triangles, its lowest corner at `offset` on every axis. */
export function cube(size: number, offset = 0): Triangle[] {
  const o = offset;
  const s = offset + size;
  const v: Point[] = [
    [o, o, o], [s, o, o], [s, s, o], [o, s, o],
    [o, o, s], [s, o, s], [s, s, s], [o, s, s],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [3, 7, 6], [3, 6, 2], // back
    [0, 4, 7], [0, 7, 3], // left
    [1, 2, 6], [1, 6, 5], // right
  ];
  return faces.map(([a, b, c]) => [v[a], v[b], v[c]]);
}

/** Corner at the origin, edges of length `a` along each axis: volume a³/6. */
export function tetrahedron(a: number): Triangle[] {
  const v: Point[] = [[0, 0, 0], [a, 0, 0], [0, a, 0], [0, 0, a]];
  return [
    [v[0], v[2], v[1]],
    [v[0], v[1], v[3]],
    [v[0], v[3], v[2]],
    [v[1], v[2], v[3]],
  ];
}

/** The same surface facing inward: a cavity. */
export function inverted(triangles: Triangle[]): Triangle[] {
  return triangles.map(([a, b, c]) => [a, c, b]);
}

export function stl(triangles: Triangle[], format: 'binary' | 'ascii'): Buffer {
  if (format === 'ascii') {
    const facets = triangles
      .map((t) => ` facet normal 0 0 0\n  outer loop\n${t.map((p) => `   vertex ${p.join(' ')}`).join('\n')}\n  endloop\n endfacet`)
      .join('\n');
    return Buffer.from(`solid test\n${facets}\nendsolid test\n`);
  }
  const buffer = Buffer.alloc(84 + 50 * triangles.length);
  buffer.write('binary test mesh', 0);
  buffer.writeUInt32LE(triangles.length, 80);
  triangles.forEach((triangle, index) => {
    const at = 84 + 50 * index + 12; // after the normal, left at zero
    triangle.flat().forEach((value, i) => buffer.writeFloatLE(value, at + 4 * i));
  });
  return buffer;
}
