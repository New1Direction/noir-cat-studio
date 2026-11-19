# Both-arm animation audit

Reviewed all 19 built-in motions in Original, Dreamcast, PS1 and PS2. Both arms were checked through each complete clip, with sampled subframes and front plus left/right three-quarter visual review. Checks distinguish low resting/swinging arms from raised, crossed, pointing and behind-body gestures; forcing every elbow into the same world direction would damage those poses.

| Motion | Result | Arm behavior |
| --- | --- | --- |
| Idle | Verified | Small relaxed forearm motion on both sides. |
| Walk | Verified | Close arm swing with forward forearms. |
| Run | Verified | Relaxed bent elbows beside the torso. |
| Sprint | Verified | Elbow routing follows the leaning torso. |
| Wave | Verified | Raised right elbow stays below the outer-cheek paw; left arm stays relaxed. |
| Sit | Verified | Both elbows hang down and the paws rest by the knees. |
| Shoot | Corrected | Left supporting forearm clears the chest through recoil; paw and prop paths retained. |
| Dive | Corrected | Both elbows stay behind the guarding paws through crouch and launch. |
| Smoke | Verified | Left resting elbow bends behind the torso; raised right arm retains its head-safe mouth reach. |
| Floss | Corrected | Both arms follow their front/behind exchange without crossing the belly. The front paw route gains at most 0.15 units of smooth depth clearance; timing, lateral/vertical sweep and rear route are retained. |
| Orange Justice | Corrected | Both low arm circles keep elbows outside the torso and forearms forward. |
| Best Mates | Corrected | Both arm pumps bend naturally beside the body. |
| Take the L | Verified | Raised cheek-side salute and opposite hip gesture retain their distinct elbow directions. |
| Electro Shuffle | Corrected | Both counter-swings keep lowered elbows and forward forearms. |
| Fresh | Corrected | Chest sweeps retain lateral elbow clearance. |
| Dance Moves | Corrected | Clap, sweep, open and tucked transitions keep elbow joints outside the torso. |
| Dab | Corrected | Crossed/raised accents retain their gesture while transition elbows clear the torso. |
| Hype | Corrected | Low pumps fold behind the paws; both elbows clear the body. |
| Groove Jam | Corrected | Pointing and rolling chest gestures use separate elbow corridors. |

The original 26-bone layout and 19 skinned meshes are retained. The existing round elbow surfaces retain their volume. Source and playback tests check pose-appropriate elbow routing, free elbow/forearm/paw surfaces against the torso, arm/head clearance, floor contact and temporal continuity. The shoulder attachment deliberately joins the torso and head underside.

Shoot and Floss bake at 60 fps to preserve their fast recoil/reach transitions. Other motions bake at 30 fps. Optimized GLB exports use tighter key reduction and are reloaded to compare both shoulder/elbow/paw trajectories with the studio, including times between source keys.

These checks cover the built-in clips. Uploaded motion remains dependent on the source video and tracking quality.
