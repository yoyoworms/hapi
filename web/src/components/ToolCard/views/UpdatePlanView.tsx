import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { ChecklistList, extractUpdatePlanChecklist, extractUpdatePlanExplanation } from '@/components/ToolCard/checklist'

export function UpdatePlanView(props: ToolViewProps) {
    const steps = extractUpdatePlanChecklist(props.block.tool.input, props.block.tool.result)
    const explanation = extractUpdatePlanExplanation(props.block.tool.input, props.block.tool.result)
    return (
        <div className="flex flex-col gap-2">
            {explanation ? (
                <div className="whitespace-pre-wrap text-sm italic text-[var(--app-hint)]">
                    {explanation}
                </div>
            ) : null}
            <ChecklistList items={steps} />
        </div>
    )
}
