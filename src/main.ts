import './style.css'
import { startWalkingSim } from './Game'

const app = document.querySelector<HTMLDivElement>('#app')
if (!app) throw new Error('Missing #app container')

startWalkingSim(app)
