# Both-knee animation audit

Checked both legs in all 19 built-in animations, in Original, Dreamcast, PS1 and PS2. Knee direction is measured in the character/pelvis frame, so a whole-body sideways dive or an intentional crossed step is not mistaken for a reversed joint.

All 19 motions already bend both knees forward correctly. The audit found one separate collision issue: Electro Shuffle's crossing shins passed through each other. Its front/back foot separation was increased while retaining the lateral crossover, lift, rhythm, body motion and arm choreography. The largest change to each requested foot path is 0.20 model units.

| Motion | Both knees | Leg review |
| --- | --- | --- |
| Idle | Verified forward | Relaxed stance. |
| Walk | Verified forward | Stance, swing and heel/toe phases. |
| Run | Verified forward | Flight and recovery bends. |
| Sprint | Verified forward | Deep recovery and longer stride. |
| Wave | Verified forward | Planted legs during the arm gesture. |
| Sit | Verified forward | Descent and held seated pose. |
| Shoot | Verified forward | Supporting stance through recoil. |
| Dive | Verified forward | Crouch, whole-body roll and held landing, measured relative to the actor. |
| Smoke | Verified forward | Relaxed planted stance through the full loop. |
| Floss | Verified forward | Swaying planted stance. |
| Orange Justice | Verified forward | Alternating low steps and knee flexion. |
| Best Mates | Verified forward | Alternating raised knees. |
| Take the L | Verified forward | Outward kicks and toe yaw. |
| Electro Shuffle | Verified forward; collision corrected | Crossing shins now use separate front/back paths. |
| Fresh | Verified forward | Alternating heel lifts. |
| Dance Moves | Verified forward | Full stepping phrase. |
| Dab | Verified forward | Planted stance under mirrored upper-body accents. |
| Hype | Verified forward | High-knee hops and opposing stance leg. |
| Groove Jam | Verified forward | Inward and crossing steps. |

The audit includes source and baked subframes, knee-plane continuity, fixed limb lengths, full-loop or held-pose behavior, actual leg/sole floor clearance and leg-to-leg separation checks. Visual review uses the front and both three-quarter sides. Export checks reload every edition's optimized GLB and compare the hips-to-knees-to-feet paths with the studio at times between keys.

The continuous leg silhouette, flat soles and 26-bone layout are retained. This report covers the built-in library; uploaded motion depends on the source video and tracking quality.
