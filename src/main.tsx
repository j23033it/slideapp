import { render } from 'preact'

import { App } from './app/App'
import './styles/tokens.css'
import './styles/base.css'

const container = document.getElementById('app')
if (!container) throw new Error('#app not found')

render(<App />, container)
