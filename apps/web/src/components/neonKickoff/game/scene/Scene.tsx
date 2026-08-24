import { Bloom, EffectComposer, Vignette } from '@react-three/postprocessing';
import { Physics } from '@react-three/rapier';
import { useGame } from '../store';
import { Ball } from './Ball';
import { GoalBurst } from './GoalBurst';
import { GoalNet } from './GoalNet';
import { CameraRig } from './CameraRig';
import { GoalFrame } from './GoalFrame';
import { PitchApron } from './PitchApron';
import { PitchLines } from './PitchLines';
import { Goalie } from './Goalie';
import { Stadium } from './Stadium';
import { Striker } from './Striker';
import { Ticker } from './Ticker';
import { TimingRing } from './TimingRing';

export function Scene() {
  const paused = useGame((s) => s.paused);

  return (
    <>
      <color attach="background" args={['#050d11']} />
      {/* pulled in tight: past the penalty area the pitch falls away into the
          dark, so nothing behind the striker competes with the goal */}
      <fog attach="fog" args={['#050d11', 16, 58]} />

      <ambientLight color="#4d6f7d" intensity={1.5} />
      <hemisphereLight color="#bfe8f5" groundColor="#12261d" intensity={1.6} />
      {/* four floodlight banks, the way a real stadium lights a night match */}
      <directionalLight
        position={[18, 26, 24]}
        intensity={2.6}
        color="#eafcff"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-18}
        shadow-camera-right={18}
        shadow-camera-top={20}
        shadow-camera-bottom={-6}
        shadow-camera-near={4}
        shadow-camera-far={80}
      />
      <directionalLight position={[-20, 24, 26]} intensity={1.5} color="#dff4ff" />
      <directionalLight position={[0, 22, -18]} intensity={0.9} color="#cfeaff" />

      {/* neon accents washing the penalty area */}
      <pointLight position={[-9, 7, 9]} color="#00ffd1" intensity={90} distance={34} />
      <pointLight position={[9, 7, 9]} color="#ff0080" intensity={70} distance={34} />
      <pointLight position={[0, 4.5, 2.5]} color="#bff7ff" intensity={40} distance={16} />
      {/* keeps the penalty area and the timing ring off the floor of the exposure */}
      <spotLight
        position={[0, 16, 14]}
        angle={0.75}
        penumbra={0.85}
        intensity={260}
        distance={46}
        color="#eaf9ff"
        target-position={[0, 0, 6]}
      />

      <PitchApron />

      <Stadium />
      <PitchLines />
      <GoalFrame />
      <TimingRing />
      <GoalBurst />
      <Goalie />
      <Striker />
      <CameraRig />
      <Ticker />

      {/* the ball and the netting are the only things simulated */}
      <Physics gravity={[0, -9.81, 0]} paused={paused}>
        <Ball />
        <GoalNet />
      </Physics>

      <EffectComposer>
        <Bloom mipmapBlur intensity={0.85} luminanceThreshold={1.0} luminanceSmoothing={0.2} />
        <Vignette eskil={false} offset={0.18} darkness={0.72} />
      </EffectComposer>
    </>
  );
}
