import * as events from "events";
import * as request from "request-promise";
import * as fs from 'fs';

const leaderboardCacheFile = 'leaderboard_cache.json';
const game = "76rqjqd8"; // botw
const srcApi = 'https://www.speedrun.com/api/v1/';
const categoryWRMap = {};
const wrEmitter = new events.EventEmitter();

interface Leaderboard {
    categoryId: string;
    categoryName: string;
    levelId: string | null;
    levelName: string | null;
    variables: ValueVariable[];
    wrRunId: string | null;
    wrRunTime: number | null;
}

interface Level {
    levelId: string;
    levelName: string;
    categories: Category[];
}

interface Category {
    id: string;
    name: string;
    variables: {[key: string]: Variable};
}

interface Variable {
    id: string;
    name: string;
    values: {[key: string]: string},
}

interface ValueVariable {
    id: string;
    name: string;
    valueId: string;
    valueName: string;
}

interface Run {
    id: string;
    time: number;
    playerName: string;
    leaderboard: Leaderboard;
}

async function srcWRLoop() {
    let oldRunIds: string[] = [];
    while(true) {
        // load cached leaderboard, if it doesn't exist, grab it fresh from src
        let leaderboards = loadLeaderboardCache();
        if (leaderboards == null) {
            leaderboards = await updateCategories();
            saveLeaderboardCache(leaderboards);
        }
        // grab newly submitted runs
        let newRuns = await newVerifiedRuns(oldRunIds, leaderboards);
        newRuns.forEach(run => {
            oldRunIds.unshift(run.id);
            // announce new run
            wrEmitter.emit('newRun',run);
            // check if it's a new WR or the first run in that category
            if (run.leaderboard.wrRunTime == null || run.time < run.leaderboard.wrRunTime) {
                run.leaderboard.wrRunTime = run.time;
                run.leaderboard.wrRunId = run.id;
                saveLeaderboardCache(leaderboards);
                wrEmitter.emit('newWR',run);
            }
        });
        // limit to 30 elements
        oldRunIds = oldRunIds.splice(0,30);
        // sleep to wait for runs
        await sleep(30000);
    }
}

function loadLeaderboardCache(): Leaderboard[] | null {
    if (!fs.existsSync(leaderboardCacheFile)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(leaderboardCacheFile, {encoding: 'utf-8'}));
}

function saveLeaderboardCache(Leaderboard: Leaderboard[]) {
    fs.writeFileSync(leaderboardCacheFile, JSON.stringify(Leaderboard), {encoding: 'utf-8'});
}

/**
 * Updates the cache file for all category WRs, including subcategories and amiibo
 */
async function updateCategories(): Promise<Leaderboard[]> {
    const response = await requestWithRetry(`${srcApi}games/${game}?embed=categories,variables,levels`, 3);
    const fullGameVariables = [];
    const levelVariables = [];
    const categoryList: Category[] = response.data.categories.data
        .filter(cat => cat.type == "per-game")
        .map(cat => {
        return {id: cat.id, name: cat.name, variables: {}};
    });
    const levelCategories: Category[] = response.data.categories.data
        .filter(cat => cat.type == "per-level")
        .map(cat => {
        return {id: cat.id, name: cat.name, variables: {}};
    });
    const levels: Level[] = response.data.levels.data.map(l => {
        return {
            levelId: l.id,
            levelName: l.name,
            // copy
            categories: levelCategories.map(cat => {return {id: cat.id, name: cat.name, variables: []}}),
        };
    });
    
    response.data.variables.data.forEach(variable => {
        // only split by subcategories and amiibo
        if (!variable["is-subcategory"] && variable.name != 'amiibo') return;

        let v: Variable = {name: variable.name, id: variable.id, values: {}};
        Object.entries(variable.values.values).forEach(([id, val]) => {
            v.values[id] = (val as any).label;
        });
        if (variable.scope.type == "global") {
            if (variable.category != null) {
                let cat = categoryList.find(cat => cat.id == variable.category);
                if (cat) {
                    cat.variables[v.id] = v;
                }
            } else {
                categoryList.forEach(cat => {
                    cat.variables[v.id] = v;
                });
            }
        } else if (variable.scope.type == "full-game") {
            if (variable.category != null) {
                let cat = categoryList.find(cat => cat.id == variable.category);
                if (cat) {
                    cat.variables[v.id] = v;
                }
            } else {
                categoryList.forEach(cat => {
                    cat.variables[v.id] = v;
                });
            }
        } else if (variable.scope.type == "all-levels") {
            if (variable.category != null) {
                levels.forEach(level => {
                    let cat = level.categories.find(cat => cat.id == variable.category);
                    if (cat) {
                        cat.variables[v.id] = v;
                    }
                });
            } else {
                levels.forEach(level => {
                    level.categories.forEach(cat => {
                        cat.variables[v.id] = v;
                    });
                });
            }
        } else if (variable.scope.type == "single-level") {
            const level = levels.find(l => l.levelId == variable.scope.level);
            if (variable.category != null) {
                let cat = level.categories.find(cat => cat.id == variable.category);
                if (cat) {
                    cat.variables[v.id] = v;
                }
            } else {
                level.categories.forEach(cat => {
                    cat.variables[v.id] = v;
                });
            }
        }
    });
    // a leaderboard for each subcategory
    const leaderboards: Leaderboard[]= [];
    categoryList.forEach(cat => {
        const varCombinations = variableCombinations(cat);
        varCombinations.forEach(combination => {
            leaderboards.push({
                categoryId: cat.id,
                categoryName: cat.name,
                levelId: null,
                levelName: null,
                variables: combination,
                wrRunId: null,
                wrRunTime: null,
            });
        })
    });
    levels.forEach(level => {
        level.categories.forEach(cat => {
            const varCombinations = variableCombinations(cat);
            varCombinations.forEach(combination => {
                leaderboards.push({
                    categoryId: cat.id,
                    categoryName: cat.name,
                    levelId: level.levelId,
                    levelName: level.levelName,
                    variables: combination,
                    wrRunId: null,
                    wrRunTime: null,
                })
            })
        })
    })
    // get the current WR for every leaderboard (for every level/category/variable)
    for(var i = 0;i<leaderboards.length;i++) {
        const leaderboard = leaderboards[i];
        const variableQuery = leaderboard.variables.map(variable => `&var-${variable.id}=${variable.valueId}`).join('');
        let leaderboardData;
        // differenciate between level and full game run
        if (leaderboard.levelId == null) {
            leaderboardData = await requestWithRetry(`${srcApi}leaderboards/${game}/category/${leaderboard.categoryId}?top=1${variableQuery}`, 3);
        } else {
            leaderboardData = await requestWithRetry(`${srcApi}leaderboards/${game}/level/${leaderboard.levelId}/${leaderboard.categoryId}?top=1${variableQuery}`, 3);
        }
        // if the leaderboard has run(s) cache the current WR
        if (leaderboardData.data.runs.length) {
            leaderboard.wrRunId = leaderboardData.data.runs[0].run.id;
            leaderboard.wrRunTime = leaderboardData.data.runs[0].run.times.primary_t;
            // need to embed players for this debug log
            //console.log(`The WR in ${formatLeaderboard(leaderboard)} is ${leaderboardData.data.runs[0].run.times.primary} by ${leaderboardData.data.players.data[0].names.international}`);
        }
        // don't make too many requests
        await sleep(1000);
    }
    saveLeaderboardCache(leaderboards);
    return leaderboards;
}

// no amiibo any% WR: https://www.speedrun.com/api/v1/leaderboards/76rqjqd8/category/vdoq4xvk?top=1&embed=players&var-gnxrr7gn=klr0jj0l

/**
 * Returns the variables for all subcategories, one entry in the array is an array of variables
 * @param cat The category to generate variables out of
 */
function variableCombinations(cat: Category): ValueVariable[][] {
    let combinations: ValueVariable[][] = [];
    const allVariables: ValueVariable[][] = Object.entries(cat.variables).map(([_, variable]) => {
        return Object.entries(variable.values).map(([valId, value]): ValueVariable => {
            return {
                id: variable.id,
                name: variable.name,
                valueId: valId,
                valueName: value,
            };
        });
    });
    allVariables.forEach((variable, idx) => {
        if (idx == 0) {
            combinations = variable.map(vari => [vari]);
        } else {
            const oldCombinations = combinations;
            combinations = [];
            oldCombinations.forEach(combination => {
                variable.forEach(value => {
                    combinations.push(combination.concat([value]));
                })
            })
        }
    });
    return combinations;
}

async function newVerifiedRuns(lastVerifiedIds: string[], leaderboards: Leaderboard[]): Promise<Run[]> {
    const runData = await requestWithRetry(`https://www.speedrun.com/api/v1/runs?game=${game}&status=verified&direction=desc&orderby=verify-date&embed=players&max=30`, 3);
    const newRuns: Run[] = [];
    for(let i = 0;i<runData.data.length;i++) {
        let curRun = runData.data[i];
        if (!lastVerifiedIds.includes(curRun.id)) {
            newRuns.push(parseRun(curRun, leaderboards));
        } else {
            break;
        }
    }
    return newRuns;
}

function parseRun(srcData: any, leaderboards: Leaderboard[]): Run {
    const rawVariables = srcData.values;
    // grab the right leaderboard
    let leaderboard: Leaderboard;
    const filtered = leaderboards
        .filter(l => {
            // check category and level, even if it's not an IL run the property exists and is null
            if (l.categoryId != srcData.category || l.levelId != srcData.level) {
                return false;
            } else {
                // check variables
                return Object.entries(rawVariables).every(([variableId,valueId]) => {
                    let matching = l.variables.filter(v => v.id == variableId);
                    // ignore extra variables that aren't seperating the leaderboard
                    if (matching.length == 0) {
                        return true;
                    }
                    // if there is a match (multiple should be impossible) check that it's the right value
                    return matching.every(v => v.valueId == valueId);
                });
            }
        });
    if (filtered.length != 1) {
        console.error(`No leaderboard could be found for the run ${srcData.id}`);
    } else {
        leaderboard = filtered[0];
    }
    return {
        id: srcData.id,
        leaderboard: leaderboard,
        playerName: srcData.players.data[0].names.international,
        time: srcData.times.primary_t,
    }
}

function formatLeaderboard(lb: Leaderboard): string {
    const varString = lb.variables.map(v => v.valueName).join(', ');
    if (lb.levelId != null) {
        return `${lb.levelName} ${lb.categoryName} (${varString})`;
    } else {
        return `${lb.categoryName} (${varString})`;
    }
}

function formatTime(time: number): string {
    let secStr;
    let secs = (time % 60);
    if (secs < 10) {
        secStr = '0'+(time % 60).toFixed(3);
    } else {
        secStr = (time % 60).toFixed(3);
    }
    if (secStr.endsWith('.000')) {
        secStr = secStr.slice(0, secStr.length - 4);
        secStr = secStr.slice()
    }
    const min = Math.floor((time / 60) % 60);
    let minStr;
    if (min == 0) {
        minStr = '';
    } else if (min < 10) {
        minStr = `0${min}m `;
    } else {
        minStr = `${min}m `;
    }
    const hour = Math.floor(time / 3600);
    let hStr;
    if (hour == 0) {
        hStr = '';
    } else {
        hStr = `${hour}h `;
    }
    return `${hStr}${minStr}${secStr}s`;
}

/**
 * Oops the site is under a lot of pressure right now
 */
async function requestWithRetry(url: string, retries: number): Promise<any> {
    for(let i = 0;i<retries;i++) {
        try {
            return await request.get(url, {json: true});
        } catch(err) {
            console.error(`Error for url ${url}:`,err);
        }
        await sleep(5000);
    }
    throw new Error(`too many retries for url ${url}`);
}

async function sleep(ms): Promise<void>{
    return new Promise(resolve=>{
        setTimeout(resolve,ms)
    })
}

//updateCategories();
/*let freeWRs = loadLeaderboardCache()
    .filter(lb => lb.wrRunId == null)
    .map(lb => formatLeaderboard(lb));
console.log(freeWRs);*/
//console.log(loadLeaderboardCache().length)
wrEmitter.on('newWR', (run: Run) => {
    console.log('New WR:',run);
});
/*wrEmitter.on('newRun', (run: Run) => {
    console.log('New run:',run);
});*/
srcWRLoop();

module.exports = {
    srcWRLoop,
    wrEmitter,
    formatLeaderboard,
    formatTime,
    updateCategories,
};