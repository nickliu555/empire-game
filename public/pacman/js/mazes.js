/* Pac-Man Royale — maze definitions (host-only; phones never render these).
 *
 * Each maze is an array of equal-length rows. Legend:
 *   '#' wall            '.' pellet            'o' power pellet
 *   ' ' empty walkable  '-' ghost-house door (ghosts only, blocks Pac-Men)
 *   'P' player spawn    'G' ghost spawn       'C' fruit spawn
 *   'T' tunnel edge (wraps horizontally to the opposite side)
 *
 * All mazes are validated for full connectivity (see scripts/test-pacman-engine.js).
 * The host picks a different maze each round via PacmanMazes.length.
 */
(function () {
  'use strict';

  const MAZES = [
    {
      name: "Warren",
      grid: [
        "#####################",
        "#o..#.....C.....#..o#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#.#P#.#.#.#.#.#.#P#.#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#...#.#.#.#.#.#.#...#",
        "#.###.#.#.#.#.#.###.#",
        "#...#.#.#...#.#.#...#",
        "###.#.#.##.##.#.#.###",
        "#.....#.......#.....#",
        "#.########-########.#",
        "T.#.....#G G#.....#.T",
        "#.#.###.#G G#.###.#.#",
        "#.....#.##-##.#.....#",
        "#####.#.#...#.#.#####",
        "#.....#...#...#.....#",
        "#.###.#.#.#.#.#.###.#",
        "#...#...#.#.#...#...#",
        "###.#.###.#.###.#.###",
        "#..P#.....#.....#P..#",
        "#.#################.#",
        "#o........C........o#",
        "#####################",
      ],
    },
    {
      name: "Tangle",
      grid: [
        "#####################",
        "#o........C........o#",
        "#.#.#.###.#.###.#.#.#",
        "#.#P#...#.#.#...#P#.#",
        "#.#.###.#.#.#.###.#.#",
        "#.....#.#.#.#.#.....#",
        "#.###.#.#.#.#.#.###.#",
        "#.#...#.#...#.#...#.#",
        "#.#.###.##.##.###.#.#",
        "#.#.#...........#.#.#",
        "#.#.#.####-####.#.#.#",
        "T...#...#G G#...#...T",
        "#.#####.#G G#.#####.#",
        "#.#.....##-##.....#.#",
        "#.#.#####...#####.#.#",
        "#.#.....#.#.#.....#.#",
        "#.###.#.#.#.#.#.###.#",
        "#.....#...#...#.....#",
        "#.#.###.#.#.#.###.#.#",
        "#.#P#...#.#.#...#P#.#",
        "#.#.#.###.#.###.#.#.#",
        "#o........C........o#",
        "#####################",
      ],
    },
    {
      name: "Weave",
      grid: [
        "#####################",
        "#o......#.C.#......o#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#..P#.#...#...#.#P..#",
        "#####.###.#.###.#####",
        "#...#...#.#.#...#...#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#.....#.......#.....#",
        "#.###.####.####.###.#",
        "#...#...........#...#",
        "#.#.###.##-##.###.#.#",
        "T.#.....#G G#.....#.T",
        "#.#####.#G G#.#####.#",
        "#.....#.##-##.#.....#",
        "#.###.#.#...#.#.###.#",
        "#.#...#...#...#...#.#",
        "#.#.#####.#.#####.#.#",
        "#.#.......#.......#.#",
        "#.###.#########.###.#",
        "#..P#.....#.....#P..#",
        "#.#.#####.#.#####.#.#",
        "#o........C........o#",
        "#####################",
      ],
    },
    {
      name: "Circuit",
      grid: [
        "#####################",
        "#o........C........o#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#P..#.#.#.#.#.#.#..P#",
        "#.#.#...#.#.#...#.#.#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#...#.#...#...#.#...#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#.#...#.#.#.#...#.#.#",
        "#.#.#.#.......#.#.#.#",
        "#.#.#.####-####.#.#.#",
        "T.#.....#G G#.....#.T",
        "#.#.#.#.#G G#.#.#.#.#",
        "#.#.#.#.##-##.#.#.#.#",
        "#.#...#.......#...#.#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#...#.#...#...#.#...#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#.#.#...#.#.#...#.#.#",
        "#P..#.#.#.#.#.#.#..P#",
        "#.#.#.#.#.#.#.#.#.#.#",
        "#o........C........o#",
        "#####################",
      ],
    },
  ];

  // Tile kinds after parsing.
  const TILE = { WALL: 0, PATH: 1, DOOR: 2 };

  /**
   * Parse a maze definition into a structured board the engine consumes.
   * Returns { name, w, h, tiles (h×w of TILE), pellets (Set 'r,c'),
   * powerPellets (Set), playerSpawns [[r,c]...], ghostSpawns [[r,c]...],
   * fruitSpawns [[r,c]...], tunnelRows (Set), door [r,c] }.
   */
  function parse(def) {
    const rows = def.grid;
    const h = rows.length;
    const w = rows[0].length;
    const tiles = [];
    const pellets = new Set();
    const powerPellets = new Set();
    const playerSpawns = [];
    const ghostSpawns = [];
    const fruitSpawns = [];
    const tunnelRows = new Set();
    const doors = [];
    for (let r = 0; r < h; r++) {
      const row = new Array(w);
      for (let c = 0; c < w; c++) {
        const ch = rows[r][c];
        const key = r + ',' + c;
        switch (ch) {
          case '#': row[c] = TILE.WALL; break;
          case '-': row[c] = TILE.DOOR; doors.push([r, c]); break;
          case '.': row[c] = TILE.PATH; pellets.add(key); break;
          case 'o': row[c] = TILE.PATH; powerPellets.add(key); break;
          case 'P': row[c] = TILE.PATH; playerSpawns.push([r, c]); break;
          case 'G': row[c] = TILE.PATH; ghostSpawns.push([r, c]); break;
          case 'C': row[c] = TILE.PATH; fruitSpawns.push([r, c]); break;
          case 'T': row[c] = TILE.PATH; tunnelRows.add(r); break;
          default: row[c] = TILE.PATH; break; // ' ' empty walkable
        }
      }
      tiles.push(row);
    }
    // Doors sorted top-to-bottom; `door` stays the TOP one (canonical for pen
    // bounds), `doors` lists every pen entrance (top + bottom).
    doors.sort(function (a, b) { return a[0] - b[0]; });
    const door = doors.length ? doors[0] : null;
    return {
      name: def.name, w, h, tiles, pellets, powerPellets,
      playerSpawns, ghostSpawns, fruitSpawns, tunnelRows, door, doors,
    };
  }

  window.PacmanMazes = MAZES;
  window.PacmanMazes.TILE = TILE;
  window.PacmanMazes.parse = parse;
})();
