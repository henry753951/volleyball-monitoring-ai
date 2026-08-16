import {
  createAnnotationWorkstationModelService,
  type AnnotationWorkstationModelOptions,
} from '~/services/annotation-workstation/workstation-model.service'

export type { AnnotationWorkstationModelOptions }

export function useAnnotationWorkstationModel(options: AnnotationWorkstationModelOptions) {
  return createAnnotationWorkstationModelService(options)
}
