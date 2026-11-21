import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { mountDom } from './dom.js';
import { PlannerSystem, whenPlannerReady } from './planner-system.js';

World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions).then((world) => {
  world.registerSystem(PlannerSystem);
  whenPlannerReady().then(mountDom);
});
