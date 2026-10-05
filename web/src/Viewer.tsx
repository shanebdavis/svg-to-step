import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PartMesh } from "./engine/protocol";

interface Props {
  meshes: PartMesh[];
  /** 0..3: how far apart to spread the stacking levels, in model heights. */
  explode: number;
  /** Changes when the camera should re-frame the model. */
  frameKey: string;
}

interface Scene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  model: THREE.Group;
}

export function Viewer({ meshes, explode, frameKey }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const three = useRef<Scene | null>(null);
  const framed = useRef<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const element = container.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(devicePixelRatio);
    element.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#f4f4f2");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -2, 3);
    scene.add(sun);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    camera.position.set(0, -200, 200);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const model = new THREE.Group();
    scene.add(model);

    const resize = () => {
      renderer.setSize(element.clientWidth, element.clientHeight);
      camera.aspect = element.clientWidth / Math.max(1, element.clientHeight);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    renderer.setAnimationLoop(() => {
      controls.update();
      renderer.render(scene, camera);
    });
    three.current = { renderer, scene, camera, controls, model };
    return () => {
      observer.disconnect();
      renderer.setAnimationLoop(null);
      controls.dispose();
      renderer.dispose();
      element.removeChild(renderer.domElement);
      three.current = null;
    };
  }, []);

  useEffect(() => {
    if (!three.current) return;
    const { model, camera, controls } = three.current;
    for (const child of [...model.children]) {
      model.remove(child);
      child.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    }
    for (const part of meshes) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(part.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      geometry.computeVertexNormals();
      const solid = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: part.color, roughness: 0.6, flatShading: true,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 30),
        new THREE.LineBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.35 }),
      );
      const group = new THREE.Group();
      group.add(solid, outline);
      group.userData.level = part.level;
      model.add(group);
    }
    if (meshes.length && framed.current !== frameKey) {
      framed.current = frameKey;
      const box = new THREE.Box3().setFromObject(model);
      const center = box.getCenter(new THREE.Vector3());
      const radius = box.getSize(new THREE.Vector3()).length() / 2;
      const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
      controls.target.copy(center);
      camera.position.copy(center).add(new THREE.Vector3(0, -0.75, 1).normalize().multiplyScalar(distance));
    }
  }, [meshes, frameKey]);

  useEffect(() => {
    if (!three.current) return;
    const { model } = three.current;
    const box = new THREE.Box3();
    for (const group of model.children) group.position.z = 0;
    box.setFromObject(model);
    const height = box.isEmpty() ? 0 : box.max.z - box.min.z;
    const levels = Math.max(1, ...model.children.map((g) => g.userData.level as number));
    for (const group of model.children) group.position.z = ((group.userData.level as number) * explode * height) / levels;
  }, [meshes, explode]);

  return (
    <div className="viewer" ref={container}>
      {unavailable && <div className="hint">3D preview unavailable: this browser has WebGL turned off.<br />Conversion and STEP download still work.</div>}
    </div>
  );
}
