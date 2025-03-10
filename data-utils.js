import '@logseq/libs'
import {
    getDateForPage,
    getDateForPageWithoutBrackets,
    getDayInText,
    getScheduledDeadlineDateDay,
    getScheduledDeadlineDateDayTime,
} from 'logseq-dateutils'
import {logseq as packageInfo} from './package.json'


function loggerWrapper(console_) {
    const prefix = `#${packageInfo.id}: `
    return {
        debug: msg => { console_.debug(prefix + msg) },
        info: msg => { console_.info(prefix + msg) },
        log: msg => { console_.log(prefix + msg) },
        warn: msg => { console_.warn(prefix + msg) },
        error: msg => { console_.error(prefix + msg) },
    }
}

export const logger = console = loggerWrapper(console)

export class Metric {
    date    // String formatted as: 1970-01-01T00:00:00.000Z
    value

    constructor(obj) {
        this.date = obj.date
        this.value = obj.value
    }
}

export class DataUtils {
    constructor(_logseq) {
        this.logseq = _logseq
    }

    async findBlock(tree, name) {
        let found = null

        tree.forEach(async function (value) {
            if(value.content === name) {
                found = value.uuid
                return
            }
        })

        if(found)
            return found
        else return null
    }

    async enterMetric(name, childName, entry) {
        const DATA_PAGE = this.logseq.settings.data_page_name
        let page = await this.logseq.Editor.getPage(DATA_PAGE)
        if(!page) {
            page = await this.logseq.Editor.createPage(DATA_PAGE, {}, { redirect: false })
            
            if(page) {
                console.log(`Created page ${DATA_PAGE}`)
            }
            else {
                console.warn(`Failed to create page ${DATA_PAGE}`)
                return
            }
        }
        else {
            console.log(`Loaded page ${DATA_PAGE}`)
        }

        let tree = await this.logseq.Editor.getPageBlocksTree(DATA_PAGE)

        console.debug(`Loaded tree with ${tree.length} blocks`)

        var blockId
        if(tree.length == 0) {
            console.debug(`Page is empty.  Inserting block ${name}`)
            blockId = (await this.logseq.Editor.appendBlockInPage(DATA_PAGE, name))?.uuid
        }
        else {
            blockId = await this.findOrCreateBlock(tree, name)
            if(blockId === null) {
                console.debug("Can not locate block to insert metric")
                return
            }
        }

        if(childName)
        {
            let parentBlock = await this.logseq.Editor.getBlock(blockId, { includeChildren: true })
            if(parentBlock?.children?.length === 0) {
                let block = await this.logseq.Editor.insertBlock(blockId, childName, {
                    before: false, sibling: false, isPageBlock: false
                })
                blockId = block?.uuid
            }
            else {
                let childId = await this.findOrCreateBlock(parentBlock?.children, childName)
                if(childId === null) {
                    console.warn("Can not locate block to insert metric")
                    return
                }
                blockId = childId
            }
            
        }
        
        let metricBlock = await this.logseq.Editor.insertBlock(blockId, entry, {
            before: false, sibling: false, isPageBlock: false
        })
        if(!metricBlock) {
            console.warn(`Failed to insert metric: ${entry}`)
        }
        else {
            console.log(`Metric inserted successfully: ${entry}`)
            
            let formattedName = name
            if(childName)
                formattedName += " / " + childName
            
            logseq.UI.showMsg(`Inserted data point for metric ${formattedName}.`)
        }
    }

    async findOrCreateBlock(tree, name) {
        console.log(`findOrCreateBlock ${name}, ${tree.length}`)
        let found = null

        tree.forEach(async function (value) {
            if(value.content === name) {
                console.debug(`Iteration name match ${value.content}, ${value.children}`)
                found = value.uuid
                return
            }
        })

        if(found)
            return found

        console.debug(`Block not found, inserting block at ${tree[tree.length - 1].uuid}`)

        let block = await this.logseq.Editor.insertBlock(tree[tree.length - 1].uuid, name, {
            before: false, sibling: true, isPageBlock: false
        })
        if(!block) {
            console.warn(`Failed to create block ${name}`)
            return null
        }

        console.log(`Created block ${name} with uuid ${block.uuid}`)

        return block?.uuid
    }

    prepareMetricsForLineChart(metrics, cumulativeMode) {
        metrics = this.sortMetricsByDate(this.filterInvalidMetrics(metrics))

        let data = []
        let sum = 0
        metrics.forEach(metric => {
            var date, value
            try {
                let y = parseFloat(metric.value)
                sum += y
                date = new Date(metric.date)
                value = { x: date, y: cumulativeMode ? sum : y }
            } catch { 
                console.debug(`Invalid meric.  date: ${metric.date}, value: ${metric.value}`)
            }
            
            data.push(value)
        })
        return data
    }

    async loadLineChart(metricName, cumulativeMode) {
        // Scenarios:
        // 1. Single dataset using data from immediate children
        // 2. Multiple datasets where data comes from grandchildren 
        
        // Modes:
        // 1. Standard - data points plotted normally along y-axis
        // 2. Cumulative - values are ordered chronologically and the cumulative sum is plotted  

        // Return value: 
        // datasets: [ { data: [ { x: (date), y: (float) } }, { ... } ] } ]

        const datasets = []
        const childNames = await this.loadMetricNames(metricName)
        if(childNames.length > 0) {
            for(const { label } of childNames) {
                const metrics = await this.loadMetrics(metricName, label)
                datasets.push({
                    data: this.prepareMetricsForLineChart(metrics, cumulativeMode),
                    label: label,
                })
            }
        }
        else {
            const metrics = await this.loadMetrics(metricName)
            datasets.push( { data: this.prepareMetricsForLineChart(metrics, cumulativeMode) } )
        }

        return datasets
    }

    // Remove any metrics that have non-numeric values or invalid dates
    filterInvalidMetrics(metrics) {
        var filtered = []
        metrics.forEach(metric => {
            if(isNaN(parseFloat(metric.value)))
                return
            if(isNaN(new Date(metric.date).valueOf()))
                return
            filtered.push(metric)
        })
        return filtered
    }

    // Chart.js requires data points to be sorted along the y-axis
    sortMetricsByDate(metrics) {
        var sorted = metrics.sort((a, b) => {
            return new Date(a.date) - new Date(b.date)
        })
        return sorted
    }

    parseMetric(content) {
        let parsed = null
        try {
            parsed = JSON.parse(content)
            if(parsed.value && parsed.date)
                return new Metric(parsed)

        }
        finally {
            return parsed
        }
    }

    async loadMetrics(metricName, childName) {
        const DATA_PAGE = this.logseq.settings.data_page_name

        var block
        const tree = await this.logseq.Editor.getPageBlocksTree(DATA_PAGE)
        let blockId = await this.findBlock(tree, metricName)
        
        if(!blockId) return []

        if(childName && childName.length > 0) {
            block = await this.logseq.Editor.getBlock(blockId, { includeChildren: true })
            blockId = await this.findBlock(block?.children, childName)
        }

        if(!blockId) return []

        block = await this.logseq.Editor.getBlock(blockId, { includeChildren: true })

        let metrics = []
        var metric
        if(childName && childName.length > 0) {
            block?.children?.forEach( (child) => {
                metric = this.parseMetric(child.content)
                if(metric)
                    metrics.push(metric)
            })
        }
        else {
            block?.children?.forEach( (child) => {
                // Child block may be an entry or it may be a label for a child metric
                // Try to parse the content to see if it's a valid metric
                metric = this.parseMetric(child.content)
                if(metric) {
                    metrics.push(metric)
                }
                else {
                    child.children.forEach((grandchild) => { 
                        metric = this.parseMetric(grandchild.content)
                        if(metric)
                            metrics.push(metric)
                    })
                }
            })
        }

        console.debug(`Loaded ${metrics.length} metrics`)

        return metrics
    }

    async loadChildMetrics(metricName) {
        console.log(`Loading child metrics for ${metricName}`)
        var metrics = {}
    
        const DATA_PAGE = this.logseq.settings.data_page_name
        const tree = await this.logseq.Editor.getPageBlocksTree(DATA_PAGE)
    
        console.debug(`Loaded tree: ${JSON.stringify(tree)}`)
    
        let blockId = await this.findBlock(tree, metricName)
        
        if(!blockId) return metrics
    
        var block = await this.logseq.Editor.getBlock(blockId, { includeChildren: true })
    
        block?.children?.forEach( (child) => {
            let parsed = this.parseMetric(child.content)
            if(parsed) { 
                // Only include child metrics
            }
            else if(child.content.length > 0) {
                metrics[child.content] = []
                child.children.forEach((grandchild) => {
                    parsed = this.parseMetric(grandchild.content)
                    if(parsed)
                        metrics[child.content].push(parsed)
                })
            }
        })
    
        return metrics
    }

    // Returns list of top-level metric names if `parent` is null.  
    // Returns list of names of child metrics if `parent` is non null.  
    async loadMetricNames(parent) {
        const DATA_PAGE = this.logseq.settings.data_page_name
        const tree = await this.logseq.Editor.getPageBlocksTree(DATA_PAGE)
        let names = []

        if(parent) {
            let blockId = await this.findBlock(tree, parent)
            let block = await this.logseq.Editor.getBlock(blockId, { includeChildren: true })
            block?.children?.forEach((child) => {
                try {
                    JSON.parse(child.content)
                }
                catch {
                    if(child.content.indexOf("{{renderer") === -1) {
                        names.push({ 
                            id: names.length,
                            uuid: child.uuid,
                            label: child.content
                        })
                    }
                }
            })
        }
        else {
            tree.forEach(async function (value) {
                if(value.content.indexOf("{{renderer") === -1) {
                    names.push({ 
                        id: names.length,
                        uuid: value.uuid,
                        label: value.content
                    })
                }
            })
        }
        return names
    }

    async propertiesQueryLineChart(properties, cumulativeMode) {
        return Promise.all(properties.map(async (prop) => {
            const results = await this.logseq.DB.datascriptQuery(`
                [:find (pull ?b [*])
                  :where
                  [?b :block/page ?p]
                  [?p :block/journal? true]
                  [?b :block/properties ?prop]
                  [(get ?prop :${prop})]
                ]
            `)

            if(!results)
                return { data: [] }

            const metrics = []
            for(const [ result ] of results) {
                const value = parseFloat(result.properties[prop])
                if(!isNaN(value)) {
                    const page = await this.logseq.Editor.getPage(result.page.id)
                    if(page) {
                        const day = page.journalDay.toString()
                        const date = new Date(day.slice(0, 4) + "-" + day.slice(4, 6) + "-" + day.slice(6) + " 00:00:00")
                        metrics.push(new Metric({ date: date, value: value }))
                    }
                }
            }

            return {
                label: prop,
                data: this.prepareMetricsForLineChart(metrics, cumulativeMode),
            }
        }))
    }

    async addToJournal(name, child, metricObj) {
        const config = await logseq.App.getUserConfigs()
        const pageName = getDateForPageWithoutBrackets(new Date(metricObj.date), config.preferredDateFormat)

        let page = await logseq.Editor.getPage(pageName)
        if(!page) {  // See if the page exists
            console.log(`Creating page ${pageName}`)
            page = await logseq.Editor.createPage(pageName, {}, { createFirstBlock: true, journal: true, redirect: false })
        }

        let fullName = name
        let property = this.clearPropertyName(name)
        if(child) {
            fullName += " / " + child

            // it seems like now @logseq/libs v0.0.14 have a bug: we cannot add property in the form "test/sub"
            // so as a temporal solution used "test___sub": it can be renamed manually in Logseq
            property += "___" + this.clearPropertyName(child)
        }

        const text = this.logseq.settings.journal_title.replaceAll("${metric}", fullName)

        return await logseq.Editor.appendBlockInPage(
            page.uuid,
            text,
            {
                properties: {
                    [property]: metricObj.value
                }
            }
        )
    }

    clearName(name) {
        // Idea: restric metric names with the same rules as Logseq restricts property names
        // Property names restrictions from Logseq itself:

        /**
         * Property name begins with a non-numeric character and can contain alphanumeric characters
         * and . * + ! - _ ? $ % & = < >.
         * If -, + or . are the first character, the second character (if any) must be non-numeric.
         */

        // But this message is wrong for Logseq v0.8.16:
        //   - ' is also allowed in property names
        //   - property name can begins with numeric character
        //   - property name can continues with numeric character after -, + or .
        //   - property name can contain non-keyboard characters like ≈, §, ⌘, smiles, etc.

        // So the real rule is:
        //     Property name cannot contain keyboard characters :;,^@#()/\{}[]|"`~ and space

        // Here, for metric (non-property) name we can restrict all these characters
        // Except of space: because it is very usefull for naming
        // But spaces should be cleaned in conversion to property

        const restrictedChars = /[:;,^@#~"`/|\(){}[\]]/g

        return name.replaceAll(restrictedChars, "")
    }

    clearPropertyName(name) {
        return this.clearName(name).replaceAll(" ", "-").toLowerCase()
    }
}

