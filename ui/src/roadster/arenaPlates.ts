// The plates of the arenas beyond the Bay: the Bay's own, painted over into
// each place with the cameras and the track kept, so the Bay's traced pixels
// (racing line, bays, posts, ramp, chase spot) fit them too. Night only: each
// arena has its own hour; a missing day plate means it stays at that hour.

import glaceChase from './plates/glace-chase.jpg';
import glaceHome from './plates/glace-home.jpg';
import glaceLaunch from './plates/glace-launch.jpg';
import glacePit from './plates/glace-pit.jpg';
import mesaChase from './plates/mesa-chase.jpg';
import mesaHome from './plates/mesa-home.jpg';
import mesaLaunch from './plates/mesa-launch.jpg';
import mesaPit from './plates/mesa-pit.jpg';
import portoChase from './plates/porto-chase.jpg';
import portoHome from './plates/porto-home.jpg';
import portoLaunch from './plates/porto-launch.jpg';
import portoPit from './plates/porto-pit.jpg';

export const ARENA_PLATES = {
  mesa: { home: { night: mesaHome }, launch: { night: mesaLaunch }, chase: { night: mesaChase }, pit: { night: mesaPit } },
  porto: { home: { night: portoHome }, launch: { night: portoLaunch }, chase: { night: portoChase }, pit: { night: portoPit } },
  glace: { home: { night: glaceHome }, launch: { night: glaceLaunch }, chase: { night: glaceChase }, pit: { night: glacePit } },
};
