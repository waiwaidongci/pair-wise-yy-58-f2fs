import { createRouter, createWebHashHistory } from 'vue-router';

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/models', component: { template: '<div />' } },
    { path: '/checks', component: { template: '<div />' } },
    { path: '/review', component: { template: '<div />' } },
    { path: '/sync', component: { template: '<div />' } }
  ]
});
