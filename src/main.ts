import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Notify, Quasar } from 'quasar';
import 'quasar/src/css/index.sass';
import '@quasar/extras/material-icons/material-icons.css';
import router from './router';
import App from './App.vue';
import './styles.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(Quasar, { plugins: { Notify } });
app.mount('#app');
