import { builder } from './builder.js'
import './inputs.js'
import './types.js'
import './queries.js'
import './mutations.js'
import './annotation-mutations.js'
import './annotation-queries.js'
import './coach-queries.js'

export const schema = builder.toSchema({ sortSchema: true })
