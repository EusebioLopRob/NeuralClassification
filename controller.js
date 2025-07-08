const { compute_complete } = require('./neural.net');

function calculatePlayersClassification(SenkaDataId, filteredData, servernum, servermame){
    return new Promise( async (resolve, reject) => {
        try{
            const playerDeltaDataset = await generatePlayersDeltaSataset(filteredData, servernum);
            const filteredDataCopy = JSON.parse(JSON.stringify(filteredData));
            for await (const [index, player] of playerDeltaDataset.entries()) {
                let numUnions = filteredDataCopy.players[index].unionData? filteredDataCopy.players[index].unionData.union : 0;
                let computeResult = await compute_complete(forceValidArray(player.data), numUnions);
                filteredDataCopy.players[index].classification = computeResult.prediction < 0? 0 : computeResult.prediction;
                filteredDataCopy.players[index].planB = computeResult.planBUsed;
            }
            filteredDataCopy.neuralReady = true;
            let classifications = findUnionThreshold(filteredDataCopy.players);
            filteredDataCopy.unionThreshold = classifications[4];
            filteredDataCopy.top10Classification = classifications.slice(0, 10);
            await SenkasuFiltered.updateOne({_id: SenkaDataId},{filteredData: filteredDataCopy});
            await PostLog('NEURAL NET', `Classification data generated for ${servermame}`, null);
            resolve();
        }catch(err){
            console.error("Senka controller::Error calculatePlayersClassification");
            console.error(err);
            reject(err)
        }
    });
}

function findUnionThreshold(players){
    let classifications = players.map(player => {
        return Math.floor(player.classification * 100) / 100;
    });
    //Order desc
    classifications.sort((a, b) => b - a);
    return classifications;
}

function generatePlayersDeltaSataset(filteredData, servernum){
    return new Promise( async (resolve, reject)=>{
        try{
            //Declare flag for no cutoff data
            let noData = false;
            //Declare flag for complete data
            let completeData = true;
            //Declare empty array for missed cuts timestamps
            const missedCutTimestamp = [];
            //Declare constant for expected time gap in between two consecutive cuts (12h)
            const timeGap = 12 * 60 * 60 * 1000;
            //Declare empry array for expected cutoff list
            var cutofflist = [];
            //Declare flag for server update status, default: true
            let serverUpdated = true;

            //If database entry contains elements on cutoff list
            if(filteredData?.cutofflist && filteredData.cutofflist.length > 0){
                //Get current date
                const today = new Date();
                //Get date of the first cut of the month
                const firstCut = new Date(`${today.getFullYear()}-${today.getMonth() + 1 }-1 ${CutTime}:00`);
                //Declare variable for the current inserted cut
                var currentInserted = firstCut.getTime() - timeGap;
                while(currentInserted < today.getTime()){
                    //While the inserted timestamp is lower than the current timestamp keep inserting timestamps into expected cutoff list
                    cutofflist.push({ timestamp: currentInserted })
                    //Update the value of the current inserted timestamp on each iteration
                    currentInserted += 43200000;
                }
                //Minimum set of increments needs to be 14, so minimun number of cutoff elements needs to be 15
                if(cutofflist.length < 15){
                    //If there can not be enough data return error response
                    reject({status: 403, message: 'Not enough data'});
                }

                //Create a copy of cutoffList for the non updated cufofflist version
                var cutoffListCopy = JSON.parse(JSON.stringify(cutofflist));
                
                //Remove the older than 15 cuts cutoffs to avoid processing uneccesary data
                cutofflist.splice(0, cutofflist.length - 15);

                //Remove the older than 16 cuts cutoffs from the copy
                cutoffListCopy.splice(0, cutofflist.length - 16);
                //Remove the most recent element
                cutoffListCopy.pop();

                //Iterate through the generated expected cutoff list
                for(let i=0; i<cutofflist.length;i++){
                    //Flag for finding a timestamp from the expected cutoff list
                    let timestampFound = false;
                    for(const cutoff of filteredData.cutofflist){
                        if(cutoff.timestamp == cutofflist[i].timestamp){
                            //Timestamp found
                            timestampFound = true;
                        }
                    }
                    //If the timestamp is not found
                    if(!timestampFound){
                        //If its the last one
                        if(i == (cutofflist.length - 1)){
                            //The server is still not updated
                            serverUpdated = false;
                        }else{
                            //The cut is missing
                            missedCutTimestamp.push(cutofflist[i].timestamp);
                            completeData = false;
                        }
                    }
                }
                if(!serverUpdated){
                    //If the server is still not updated take the non updated timestamp version
                    cutofflist = cutoffListCopy;
                }
            }else{
                //No elements into cutoff list
                noData = true;
            }
            if(noData){
                //Return error response if no data founs
                reject({status: 403, message: 'No data found'});
            }
            //Declare enpty array for players dataset
            const playerDatasets = [];
            //Declare null variable for external API data
            var otherSourcesServerData = null
            if(!completeData){
                //If data is not complete, request data from other sources
                try{
                    otherSourcesServerData = await getDataFromOtherSources(servernum);
                }catch(err){
                    console.log('Other sources data error');
                }
            }
            //Iterate through the current player list (no need to check if this list has entries because it will always have entries if the database cutoff list has entries)
            for(const player of filteredData.players){
                //Insert a player object containing identification data and an empty array for scores
                playerDatasets.push({
                    name: player.name,
                    comment: player.comment,
                    medal: player.curMedal,
                    data: []
                });
                //Obtain the currently inserted index
                const pushedIndex = playerDatasets.length - 1;
                if(!completeData){
                    //If the data is not complete decide where to take the score value from

                    //Reversely iterate through expected cutoff list array
                    for(let j = (cutofflist.length - 1); j>=0; j--){
                        //If the currently checked cutoff timestamp is included into the missing cutoff timestamps
                        if(missedCutTimestamp.includes(cutofflist[j].timestamp)){
                            //take data from other sources

                            //Iterate through the playerlist from external data playerlist
                            if(otherSourcesServerData){
                                for(const otherSourcePlayer of otherSourcesServerData.players){
                                    //Find the player that meets the identification criteria
                                    if(otherSourcePlayer.name == player.name && otherSourcePlayer.comment == player.comment && otherSourcePlayer.medal == player.medal){
                                        //Iterate though the score array of the found player
                                        for(const entry of otherSourcePlayer.senka){
                                            //If the timestamp of the currenty checked score matches the missing cutoff timestamp
                                            if(entry.timestamp == cutofflist[j].timestamp){
                                                //Push the score into the currently inserted player data array
                                                playerDatasets[pushedIndex].data.push(entry.senka);
                                            }
                                        }
                                    }
                                }
                            }
                        }else{
                            //If the currently checked cutoff timestamp is not included into the missing cutoff timestamps

                                //take data from our system

                                //Iterate though the currently checked player score array
                                for(const entry of player.senka){
                                    //If the currently checked timestamp matches the currently checked expected timestamp
                                    if(entry.timestamp == cutofflist[j].timestamp){
                                        //Push the score into the currently inserted player data array
                                        playerDatasets[pushedIndex].data.push(entry.senka);
                                    }
                                }

                        }
                    }
                }else{
                    //The data is complete, take data from our system
                    //Reversely iterate through expected cutoff list array
                    for(let j = (cutofflist.length - 1); j>=0; j--){
                        //if not in the case of last checked expected cutoff and sever not updated

                            //Iterate though the currently checked player score array

                                for(const entry of player.senka){
                                    //If the currently checked timestamp matches the currently checked expected timestamp
                                    if(entry.timestamp == cutofflist[j].timestamp){
                                        //Push the score into the currently inserted player data array
                                        playerDatasets[pushedIndex].data.push(entry.senka);
                                    }
                                }
                        
                    }
                }
            }
            //Declare empty array for player dataset scores increment
            const playerDeltaDataset = [];
            //Iterate through the just generated player dataset array
            for(const player of playerDatasets){
                //Insert a player object containing identification data and an empty array for scores increments
                playerDeltaDataset.push({
                    name: player.name,
                    comment: player.comment,
                    medal: player.medal,
                    data: []
                });
                //Obtain the currently inserted index
                const pushedIndex = playerDeltaDataset.length - 1;
                //Iterate through the player scores dataset
                for (let k = 0; k < player.data.length; k++) {
                    //Insert the incremement score
                    playerDeltaDataset[pushedIndex].data.push(player.data[k] - player.data[k + 1]);
                    //If the currently inserted increment array reached 14 length
                    if(playerDeltaDataset[pushedIndex].data.length === 14){
                        //Enough data gathered, stop iterating
                        break;
                    }
                }  
            }
            resolve(playerDeltaDataset);
        }catch(err){
            console.log(err);
            reject({status: 500});
        }
    });
}