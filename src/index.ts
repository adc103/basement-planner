import { DepthSensingSystem, World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { mountDom } from './dom.js';
import { PlannerSystem, whenPlannerReady } from './planner-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  // Real-world depth: lets real objects (and your hands) hide the planned walls.
  world.registerSystem(DepthSensingSystem, {
    configData: { enableDepthTexture: true, enableOcclusion: true, useFloat32: true, blurRadius: 20 },
  });
  world.registerSystem(PlannerSystem);
  whenPlannerReady().then(mountDom);
});
