import { sampleClassicDance } from './dances-classic.js';
import { samplePartyDance } from './dances-party.js';

// Original procedural interpretations, adapted to Noir's short limbs and
// oversized head. Every phrase is sampled into a portable skeletal clip.
export const DANCES = [
  { name: 'Floss', duration: 4, description: 'Side-to-side hip swings, with paws sweeping in front and behind.' },
  { name: 'Orange Justice', duration: 4, description: 'A low, bouncy groove with rolling shoulders and big arm circles.' },
  { name: 'Best Mates', duration: 4, description: 'A cheerful high-knee bounce, with loose elbows and swinging paws.' },
  { name: 'Take the L', duration: 4, description: 'A playful cheek-side salute with alternating outward heel kicks.' },
  { name: 'Electro Shuffle', duration: 6, description: 'Quick crossover steps, heel-toe turns, and relaxed counter-swinging arms.' },
  { name: 'Fresh', duration: 4, description: 'A smooth pendulum sway with an easy shoulder-and-paw groove.' },
  { name: 'Dance Moves', duration: 8, description: 'An eight-second party phrase of claps, open arms, and crossed-paw accents.' },
  { name: 'Dab', duration: 4, description: 'Alternating dabs, with a tucked face and one paw reaching wide.' },
  { name: 'Hype', duration: 4, description: 'An energetic knee-lift bounce with rhythmic paw pumps.' },
  { name: 'Groove Jam', duration: 8, description: 'Disco-style points, rolling arms, and a little cross-step finish.' },
];

export function sampleDancePose(rig, name, time, duration, helpers) {
  return sampleClassicDance(rig, name, time, duration, helpers)
    || samplePartyDance(rig, name, time, duration, helpers);
}
